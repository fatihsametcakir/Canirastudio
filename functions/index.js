/**
 * Can & Irina Studio — Öğrenci portalı sunucu fonksiyonu
 *
 * Öğrenci artık veritabanına doğrudan bağlanmaz. Tüm işlemler bu fonksiyondan geçer:
 *   giris   : telefon + şifre → oturum anahtarı (şifreler scrypt ile özetlenmiş tutulur, yanlış denemede kilit)
 *   veri    : yalnızca o öğrencinin kendi bilgileri (başkasının kaydı asla dönmez)
 *   sifre   : şifre değiştir
 *   not     : stüdyoya not gönder
 *   cikis   : oturumu kapat
 * Oturumlar Firestore'da `portal_oturum` koleksiyonunda (anahtarın SHA-256 özetiyle) tutulur.
 * Bu koleksiyonlara istemci erişemez (Firestore kuralları yalnız yöneticilere izin verir; Admin SDK kuralları aşar).
 */
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { gelirHesapla } = require('./hesap'); // yönetici uygulamasındaki hesaptan otomatik üretilir (tools/hesap-uret.js)
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const OTURUM_SURESI_MS = 12 * 60 * 60 * 1000;      // 12 saat
const KALICI_OTURUM_MS = 60 * 24 * 60 * 60 * 1000; // "Beni hatırla": 60 gün (her kullanımda uzar)
const KILIT_ESIK = 5;                               // 5 hatalı denemede kilit
const KILIT_SURELERI_DK = [5, 15, 60, 240];         // artan kilit süreleri
const IP_ESIK = 40;                                // ortak ağlarda (stüdyo Wi-Fi'ı, operatör) herkesi kilitlememek için yüksek
const NOT_GUNLUK_LIMIT = 5;

const son10 = (t) => String(t || '').replace(/\D/g, '').slice(-10);
const son4 = (t) => String(t || '').replace(/\D/g, '').slice(-4);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function sifreOzetle(sifre, tuz) {
  tuz = tuz || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(sifre), tuz, 32).toString('hex');
  return { hash, tuz };
}
function sifreDogruMu(sifre, kayit) {
  const { hash } = sifreOzetle(sifre, kayit.tuz);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(kayit.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function metinTemizle(s, max) {
  return String(s == null ? '' : s).replace(/[<>"`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function hata(res, kod, mesaj, ekstra) {
  res.status(kod).json(Object.assign({ hata: mesaj }, ekstra || {}));
}

// ── Kilit (kaba kuvvet koruması): hem telefon hem IP için ──
async function kilitKontrol(anahtar) {
  const snap = await db.collection('portal_kilit').doc(anahtar).get();
  if (!snap.exists) return 0;
  const d = snap.data();
  const kalan = Math.ceil(((d.kilitBitis || 0) - Date.now()) / 1000);
  return kalan > 0 ? kalan : 0;
}
async function hataKaydet(anahtar, esik) {
  esik = esik || KILIT_ESIK;
  const ref = db.collection('portal_kilit').doc(anahtar);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.exists ? s.data() : { sayac: 0, seviye: 0 };
    const simdi = Date.now();
    // 24 saatten eski hataları unut
    if (d.son && simdi - d.son > 24 * 3600 * 1000) { d.sayac = 0; d.seviye = 0; }
    d.sayac = (d.sayac || 0) + 1;
    d.son = simdi;
    if (d.sayac >= esik) {
      const dk = KILIT_SURELERI_DK[Math.min(d.seviye || 0, KILIT_SURELERI_DK.length - 1)];
      d.kilitBitis = simdi + dk * 60 * 1000;
      d.seviye = (d.seviye || 0) + 1;
      d.sayac = 0;
    }
    tx.set(ref, d);
  });
}
async function kilitSifirla(anahtar) {
  await db.collection('portal_kilit').doc(anahtar).delete().catch(() => {});
}
const kilitMesaj = (sn) => `Çok fazla hatalı deneme. ${sn > 90 ? Math.ceil(sn / 60) + ' dakika' : sn + ' saniye'} sonra tekrar deneyin.`;

// ── Oturum ──
async function oturumAc(ogrenciId, ilkGiris, kalici, egitmenId) {
  const anahtar = crypto.randomBytes(32).toString('hex');
  await db.collection('portal_oturum').doc(sha(anahtar)).set({
    ...(egitmenId ? { egitmenId } : { ogrenciId }), ilkGiris: !!ilkGiris, kalici: !!kalici, exp: Date.now() + (kalici ? KALICI_OTURUM_MS : OTURUM_SURESI_MS), olusturma: Date.now(),
  });
  return anahtar;
}
async function oturumBul(anahtar) {
  if (!anahtar || typeof anahtar !== 'string' || anahtar.length !== 64) return null;
  const ref = db.collection('portal_oturum').doc(sha(anahtar));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const d = snap.data();
  if ((d.exp || 0) < Date.now()) { await ref.delete().catch(() => {}); return null; }
  // Kalıcı oturum her kullanımda yeniden uzar (günde en fazla bir kez yazılır)
  if (d.kalici && (d.exp - Date.now()) < KALICI_OTURUM_MS - 24 * 3600 * 1000) {
    d.exp = Date.now() + KALICI_OTURUM_MS;
    await ref.update({ exp: d.exp }).catch(() => {});
  }
  return { ref, ...d };
}

// ── İşlemler ──
async function giris(req, res) {
  const tel = son10(req.body.tel);
  const sifre = String(req.body.sifre || '').trim();
  if (!tel || tel.length < 10 || !sifre || sifre.length > 100) return hata(res, 400, 'Telefon ve şifre zorunludur.');

  const ipAnahtar = 'ip_' + sha(req.ip || 'bilinmiyor').slice(0, 24);
  const telAnahtar = 'tel_' + tel;
  const k1 = await kilitKontrol(ipAnahtar), k2 = await kilitKontrol(telAnahtar);
  const kilit = Math.max(k1, k2);
  if (kilit > 0) return hata(res, 429, kilitMesaj(kilit), { kilit });

  const ogSnap = await db.collection('ogrenciler').get();
  // Aynı telefonu paylaşan öğrenciler olabilir (kardeş/aile): şifresi uyan kayıt seçilir
  const adaylar = ogSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((o) => son10(o.tel) === tel);
  // Kullanıcı var/yok bilgisini sızdırmamak için aynı hata
  const GENEL = 'Telefon numarası veya şifre hatalı.';
  if (!adaylar.length) { await hataKaydet(ipAnahtar, IP_ESIK); return hata(res, 401, GENEL); }

  let og = null, dogru = false, ilkGiris = false;
  for (const aday of adaylar) {
    const hesapRef = db.collection('ogrenci_hesaplar').doc(aday.id);
    const hesap = await hesapRef.get();
    const h = hesap.exists ? hesap.data() : {};
    let ok = false, ilk = false;
    if (h.hash && h.tuz) {
      ok = sifreDogruMu(sifre, h);
    } else if (h.sifre) {
      // Eski düz metin şifre: doğrulanırsa özetli forma çevir, düz metni sil
      ok = String(h.sifre) === sifre;
      if (ok) {
        const o = sifreOzetle(sifre);
        await hesapRef.set({ hash: o.hash, tuz: o.tuz, guncelleme: Date.now() });
      }
    } else {
      // Hiç şifre belirlenmemiş: ilk şifre telefonun son 4 hanesi, ilk girişte değiştirilmek zorunda
      ok = sifre === son4(aday.tel);
      ilk = true;
    }
    if (ok) { og = aday; dogru = true; ilkGiris = ilk; break; }
  }

  if (!dogru) {
    await hataKaydet(ipAnahtar, IP_ESIK); await hataKaydet(telAnahtar);
    return hata(res, 401, GENEL);
  }
  await kilitSifirla(telAnahtar);
  const anahtar = await oturumAc(og.id, ilkGiris, !!req.body.hatirla);
  res.json({ ok: true, token: anahtar, ilkGiris, ad: og.ad || '', soyad: og.soyad || '' });
}

async function veri(req, res, ot) {
  if (ot.ilkGiris) return res.json({ ilkGiris: true });
  const id = ot.ogrenciId;
  const ogDoc = await db.collection('ogrenciler').doc(id).get();
  if (!ogDoc.exists) return hata(res, 404, 'Kayıt bulunamadı.');
  const o = ogDoc.data();
  const ogrenci = { id, ad: o.ad, soyad: o.soyad || '', cinsiyet: o.cinsiyet || '', durum: o.durum || 'aktif', tel: o.tel || '', not: o.not || '' };

  const q = (kol) => db.collection(kol).where('ogrenciId', '==', id).get().then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })));
  const [siniflarSnap, odemeler, yoklamalar, ozelPaketler, ozelSeanslar, ogrenciGecmisi, tatillerSnap, egitSnap] = await Promise.all([
    db.collection('siniflar').get(), q('odemeler'), q('yoklamalar'), q('ozelPaketler'), q('ozelSeanslar'), q('ogrenciGecmisi'),
    db.collection('tatiller').get(), db.collection('egitmenler').get(),
  ]);

  // Sınıflar: yalnızca kayıtlı olduğu sınıflar; diğer öğrencilerin kayıtları ve kira/eğitmen payı alanları çıkarılır
  const siniflar = siniflarSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => (s.kayitlar || []).some((k) => k.ogrenciId === id))
    .map((s) => ({
      id: s.id, ad: s.ad, gun: s.gun, saat: s.saat, durum: s.durum || 'aktif', paket: s.paket, tekders: s.tekders,
      donemBaslangic: s.donemBaslangic || null, acilisTarihi: s.acilisTarihi || null,
      egitmenId: s.egitmenId || null, egitmen2Id: s.egitmen2Id || null,
      kayitlar: (s.kayitlar || []).filter((k) => k.ogrenciId === id),
    }));
  const egitmenler = egitSnap.docs.map((d) => ({ id: d.id, ad: d.data().ad }));
  const notlarim = (await q('ogrenci_notlar')).sort((a, b) => (b.olusturma || 0) - (a.olusturma || 0)).slice(0, 10)
    .map((n) => ({ id: n.id, ogrenciId: id, mesaj: n.mesaj, tarih: n.tarih, olusturma: n.olusturma }));
  const ozelPaketIdler = new Set(ozelPaketler.map((p) => p.id));
  res.json({
    ogrenciler: [ogrenci], siniflar, odemeler, yoklamalar, ozelPaketler,
    ozelSeanslar: ozelSeanslar.filter((s) => !s.paketId || ozelPaketIdler.has(s.paketId)),
    ogrenciGecmisi, tatiller: tatillerSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    egitmenler, notlarim,
  });
}

async function sifreDegistir(req, res, ot) {
  const yeni = String(req.body.yeni || '');
  const eski = String(req.body.eski || '');
  if (yeni.length < 6 || yeni.length > 60) return hata(res, 400, 'Yeni şifre en az 6 karakter olmalı.');
  const hesapRef = db.collection('ogrenci_hesaplar').doc(ot.ogrenciId);
  if (!ot.ilkGiris) {
    const h = (await hesapRef.get()).data() || {};
    const telAnahtar = 'sf_' + ot.ogrenciId;
    const kilit = await kilitKontrol(telAnahtar);
    if (kilit > 0) return hata(res, 429, kilitMesaj(kilit));
    const dogru = h.hash ? sifreDogruMu(eski, h) : String(h.sifre || '') === eski;
    if (!dogru) { await hataKaydet(telAnahtar); return hata(res, 401, 'Mevcut şifre hatalı.'); }
    await kilitSifirla(telAnahtar);
  } else {
    const ogDoc = await db.collection('ogrenciler').doc(ot.ogrenciId).get();
    if (yeni === son4((ogDoc.data() || {}).tel)) return hata(res, 400, 'Yeni şifre telefon numaranızın son 4 hanesi olamaz.');
  }
  const o = sifreOzetle(yeni);
  await hesapRef.set({ hash: o.hash, tuz: o.tuz, guncelleme: Date.now() });
  await ot.ref.update({ ilkGiris: false });
  // Diğer açık oturumları kapat (bu oturum kalsın)
  const digerleri = await db.collection('portal_oturum').where('ogrenciId', '==', ot.ogrenciId).get();
  await Promise.all(digerleri.docs.filter((d) => d.id !== ot.ref.id).map((d) => d.ref.delete()));
  res.json({ ok: true });
}

async function notGonder(req, res, ot) {
  if (ot.ilkGiris) return hata(res, 403, 'Önce şifrenizi değiştirin.');
  const mesaj = metinTemizle(req.body.mesaj, 500);
  if (!mesaj) return hata(res, 400, 'Mesaj boş olamaz.');
  const bugun = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const sayacRef = db.collection('portal_kilit').doc(`not_${ot.ogrenciId}_${bugun}`);
  const s = await sayacRef.get();
  if (s.exists && s.data().sayi >= NOT_GUNLUK_LIMIT) return hata(res, 429, 'Bugün için mesaj sınırına ulaştınız.');
  const ogDoc = await db.collection('ogrenciler').doc(ot.ogrenciId).get();
  const og = ogDoc.data() || {};
  await db.collection('ogrenci_notlar').add({
    ogrenciId: ot.ogrenciId, ad: metinTemizle(`${og.ad || ''} ${og.soyad || ''}`, 80),
    mesaj, tarih: bugun, olusturma: Date.now(), okundu: false,
  });
  await sayacRef.set({ sayi: (s.exists ? s.data().sayi : 0) + 1, son: Date.now() });
  res.json({ ok: true });
}


// ════════════════════════════════════════════════════════════
// EĞİTMEN PANELİ
// Eğitmen yalnızca kendi sınıflarını/öğrencilerini ve kendi özel ders paketlerini (ücret bilgisi OLMADAN) görür.
// Ödeme, gelir-gider ve başka eğitmenlerin verisi sunucudan hiç gönderilmez.
// Özel derste yalnızca takvim planlaması yapabilir (paket oluşturma/düşme yok).
// ════════════════════════════════════════════════════════════
const kalanSaat = (p) => (Number(p.toplamSaat) || 0) - (Number(p.yapilanSaat) || 0);
const paketAktif = (p) => kalanSaat(p) > 0.0001;
const TARIH_RE = /^\d{4}-\d{2}-\d{2}$/, SAAT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function egitmenGiris(req, res) {
  const tel = son10(req.body.tel);
  const sifre = String(req.body.sifre || '').trim();
  if (!tel || tel.length < 10 || !sifre || sifre.length > 100) return hata(res, 400, 'Telefon ve şifre zorunludur.');
  const ipAnahtar = 'ip_' + sha(req.ip || 'bilinmiyor').slice(0, 24);
  const telAnahtar = 'etel_' + tel;
  const kilit = Math.max(await kilitKontrol(ipAnahtar), await kilitKontrol(telAnahtar));
  if (kilit > 0) return hata(res, 429, kilitMesaj(kilit), { kilit });

  const snap = await db.collection('egitmenler').get();
  const adaylar = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => son10(e.tel) === tel);
  const GENEL = 'Telefon numarası veya şifre hatalı.';
  if (!adaylar.length) { await hataKaydet(ipAnahtar, IP_ESIK); return hata(res, 401, GENEL); }

  let eg = null, ilkGiris = false;
  for (const aday of adaylar) {
    const h = ((await db.collection('egitmen_hesaplar').doc(aday.id).get()).data()) || {};
    let ok = false, ilk = false;
    if (h.hash && h.tuz) ok = sifreDogruMu(sifre, h);
    else { ok = sifre === son4(aday.tel); ilk = true; } // ilk şifre: telefonun son 4 hanesi, ilk girişte değiştirilir
    if (ok) { eg = aday; ilkGiris = ilk; break; }
  }
  if (!eg) { await hataKaydet(ipAnahtar, IP_ESIK); await hataKaydet(telAnahtar); return hata(res, 401, GENEL); }
  await kilitSifirla(telAnahtar);
  const anahtar = await oturumAc(null, ilkGiris, !!req.body.hatirla, eg.id);
  res.json({ ok: true, token: anahtar, ilkGiris, ad: eg.ad || '' });
}


// ── Gelir özeti: yönetici uygulamasıyla AYNI hesap (hesap.js), yalnızca eğitmenin kendi payı ──
// Hesap tüm koleksiyonları okur, o yüzden sonuç eğitmen başına `egitmen_gelir/{id}` belgesinde GELIR_TTL_MS süreyle saklanır.
const GELIR_TTL_MS = 10 * 60 * 1000;
async function gelirBul(E) {
  const ref = db.collection('egitmen_gelir').doc(E);
  const onbellek = await ref.get();
  if (onbellek.exists && Date.now() - (onbellek.data().guncelleme || 0) < GELIR_TTL_MS) {
    return { siniflar: onbellek.data().siniflar || [], guncelleme: onbellek.data().guncelleme };
  }
  const liste = async (k) => (await db.collection(k).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const [siniflar, ogrenciler, odemeler, egitmenler, tatiller, ogrenciGecmisi, gSnap, eskiSnap] = await Promise.all([
    liste('siniflar'), liste('ogrenciler'), liste('odemeler'), liste('egitmenler'), liste('tatiller'), liste('ogrenciGecmisi'),
    db.collection('ayarlar').doc('giderAyarlari').get(), db.collection('gider_ayarlari').doc('ayarlar').get(),
  ]);
  const giderAyarlari = gSnap.exists ? gSnap.data() : (eskiSnap.exists ? eskiSnap.data() : {});
  const harita = gelirHesapla({ siniflar, ogrenciler, odemeler, egitmenler, tatiller, ogrenciGecmisi, giderAyarlari });
  const simdi = Date.now();
  const batch = db.batch();
  egitmenler.forEach((e) => batch.set(db.collection('egitmen_gelir').doc(e.id), { siniflar: harita[e.id] || [], guncelleme: simdi }));
  await batch.commit();
  return { siniflar: harita[E] || [], guncelleme: simdi };
}

async function egitmenVeri(req, res, ot) {
  if (ot.ilkGiris) return res.json({ ilkGiris: true });
  const E = ot.egitmenId;
  const egDoc = await db.collection('egitmenler').doc(E).get();
  if (!egDoc.exists) return hata(res, 404, 'Eğitmen kaydı bulunamadı.');
  const [siniflarSnap, ogSnap, paketSnap, seansSnap, egSnap, gecSnap, gelir] = await Promise.all([
    db.collection('siniflar').get(), db.collection('ogrenciler').get(), db.collection('ozelPaketler').get(),
    db.collection('ozelSeanslar').where('egitmenId', '==', E).get(), db.collection('egitmenler').get(),
    db.collection('ogrenciGecmisi').where('olay', '==', 'cikis').get(),
    gelirBul(E),
  ]);
  const egAd = {}; egSnap.docs.forEach((d) => { egAd[d.id] = d.data().ad || ''; });
  const ogMap = {}; ogSnap.docs.forEach((d) => { ogMap[d.id] = { id: d.id, ...d.data() }; });
  const ogGoster = (o) => ({ id: o.id, ad: o.ad || '', soyad: o.soyad || '', cinsiyet: o.cinsiyet || '', tel: String(o.tel || '').replace(/\D/g, ''), durum: o.durum || 'aktif', asistan: !!o.asistan });

  const benimSiniflar = siniflarSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.egitmenId === E || s.egitmen2Id === E);
  const sinifIdler = new Set(benimSiniflar.map((s) => s.id));
  const ogSiniflar = {}; // öğrenci -> {sinifId: {ad, aktifKayit}}
  const ekle = (ogId, sId, ad, kayitli, dondu) => { (ogSiniflar[ogId] = ogSiniflar[ogId] || {})[sId] = { id: sId, ad, kayitli, dondu: !!dondu }; };
  const siniflar = benimSiniflar.map((s) => {
    const kayitlar = (s.kayitlar || []).filter((k) => ogMap[k.ogrenciId]);
    kayitlar.forEach((k) => ekle(k.ogrenciId, s.id, s.ad, true, k.dondu || k.donduruldu));
    return {
      id: s.id, ad: s.ad, gun: s.gun, saat: s.saat, durum: s.durum || 'aktif', paket: s.paket, tekders: s.tekders,
      egitmenId: s.egitmenId || null, egitmen2Id: s.egitmen2Id || null,
      egitmenAdlari: [s.egitmenId, s.egitmen2Id].filter(Boolean).map((i) => egAd[i]).filter(Boolean),
      ogrenciIdler: [...new Set(kayitlar.map((k) => k.ogrenciId))],
    };
  });
  // Sınıftan ayrılmış (pasif) öğrenciler: çıkış günlüğünden
  gecSnap.docs.map((d) => d.data()).filter((g) => sinifIdler.has(g.sinifId) && ogMap[g.ogrenciId])
    .forEach((g) => { const o = ogSiniflar[g.ogrenciId] || {}; if (!o[g.sinifId]) ekle(g.ogrenciId, g.sinifId, g.sinifAdi || '', false); });
  const ogrenciler = Object.keys(ogSiniflar).map((id) => ({ ...ogGoster(ogMap[id]), siniflar: Object.values(ogSiniflar[id]) }));

  // Özel ders: yalnızca bu eğitmenin paketleri; ÜCRET/ÖDEME alanları gönderilmez
  const paketler = paketSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => (p.egitmenIds || []).includes(E) && ogMap[p.ogrenciId])
    .map((p) => ({ id: p.id, ogrenciId: p.ogrenciId, toplamSaat: p.toplamSaat || 0, yapilanSaat: p.yapilanSaat || 0, tarih: p.tarih || '', aktif: paketAktif(p) }));
  const seanslar = seansSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => ogMap[x.ogrenciId])
    .map((x) => ({ id: x.id, ogrenciId: x.ogrenciId, paketId: x.paketId || null, tarih: x.tarih, saat: x.saat, sure: x.sure || 1, dusuldu: !!x.dusuldu }));
  const ozelOgIdler = new Set([...paketler.map((p) => p.ogrenciId), ...seanslar.map((x) => x.ogrenciId)]);
  const ozelOgrenciler = [...ozelOgIdler].map((id) => ogGoster(ogMap[id]));
    res.json({ egitmen: { id: E, ad: (egDoc.data() || {}).ad || '' }, siniflar, ogrenciler, paketler, seanslar, ozelOgrenciler, gelir });
}

async function egitmenSifre(req, res, ot) {
  const yeni = String(req.body.yeni || ''), eski = String(req.body.eski || '');
  if (yeni.length < 6 || yeni.length > 60) return hata(res, 400, 'Yeni şifre en az 6 karakter olmalı.');
  const ref = db.collection('egitmen_hesaplar').doc(ot.egitmenId);
  if (!ot.ilkGiris) {
    const h = (await ref.get()).data() || {};
    const k = 'esf_' + ot.egitmenId;
    const kilit = await kilitKontrol(k);
    if (kilit > 0) return hata(res, 429, kilitMesaj(kilit));
    if (!(h.hash && sifreDogruMu(eski, h))) { await hataKaydet(k); return hata(res, 401, 'Mevcut şifre hatalı.'); }
    await kilitSifirla(k);
  } else {
    const eg = (await db.collection('egitmenler').doc(ot.egitmenId).get()).data() || {};
    if (yeni === son4(eg.tel)) return hata(res, 400, 'Yeni şifre telefon numaranızın son 4 hanesi olamaz.');
  }
  const o = sifreOzetle(yeni);
  await ref.set({ hash: o.hash, tuz: o.tuz, guncelleme: Date.now() });
  await ot.ref.update({ ilkGiris: false });
  const digerleri = await db.collection('portal_oturum').where('egitmenId', '==', ot.egitmenId).get();
  await Promise.all(digerleri.docs.filter((d) => d.id !== ot.ref.id).map((d) => d.ref.delete()));
  res.json({ ok: true });
}

function planAlanlari(b) {
  const tarih = String(b.tarih || ''), saat = String(b.saat || ''), sure = Number(b.sure);
  if (!TARIH_RE.test(tarih) || !SAAT_RE.test(saat)) return { hata: 'Tarih ve saat geçerli olmalı.' };
  if (!(sure >= 0.5 && sure <= 4) || (sure * 2) % 1 !== 0) return { hata: 'Süre 0,5 ile 4 saat arasında, yarım saat adımlarıyla olmalı.' };
  const bugun = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  if (tarih < bugun) return { hata: 'Geçmiş bir tarihe ders planlanamaz.' };
  return { tarih, saat, sure };
}
const dk = (saat) => Number(saat.slice(0, 2)) * 60 + Number(saat.slice(3));
async function cakisma(E, tarih, saat, sure, haricId) {
  const s = await db.collection('ozelSeanslar').where('egitmenId', '==', E).get();
  const a1 = dk(saat), a2 = a1 + sure * 60;
  return s.docs.some((d) => {
    if (d.id === haricId) return false;
    const x = d.data(); if (x.tarih !== tarih || !x.saat) return false;
    const b1 = dk(x.saat), b2 = b1 + (x.sure || 1) * 60;
    return a1 < b2 && b1 < a2;
  });
}
async function egitmenPlanla(req, res, ot) {
  if (ot.ilkGiris) return hata(res, 403, 'Önce şifrenizi değiştirin.');
  const E = ot.egitmenId, b = req.body;
  const f = planAlanlari(b); if (f.hata) return hata(res, 400, f.hata);
  const ogrenciId = String(b.ogrenciId || '');
  const paketler = (await db.collection('ozelPaketler').where('ogrenciId', '==', ogrenciId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => (p.egitmenIds || []).includes(E) && paketAktif(p))
    .sort((a, c) => (a.tarih || '').localeCompare(c.tarih || '') || (a.olusturma || 0) - (c.olusturma || 0));
  const paket = paketler[0];
  if (!paket) return hata(res, 400, 'Bu öğrencinin sizinle aktif bir özel ders paketi yok.');
  if (await cakisma(E, f.tarih, f.saat, f.sure, null)) return hata(res, 409, 'Bu saatte başka bir dersiniz var.');
  const ref = await db.collection('ozelSeanslar').add({
    ogrenciId, egitmenId: E, paketId: paket.id, tarih: f.tarih, saat: f.saat, sure: f.sure,
    dusuldu: false, olusturma: Date.now(), kaynak: 'takvim', planlayan: 'egitmen',
  });
  res.json({ ok: true, id: ref.id });
}
async function benimPlanSeansi(req, res, ot) {
  const ref = db.collection('ozelSeanslar').doc(String(req.body.id || '_yok'));
  const snap = await ref.get();
  if (!snap.exists || snap.data().egitmenId !== ot.egitmenId) { hata(res, 404, 'Ders bulunamadı.'); return null; }
  if (snap.data().dusuldu) { hata(res, 400, 'Paketten düşülmüş ders değiştirilemez.'); return null; }
  return { ref, d: snap.data() };
}
async function egitmenPlanDuzenle(req, res, ot) {
  if (ot.ilkGiris) return hata(res, 403, 'Önce şifrenizi değiştirin.');
  const s = await benimPlanSeansi(req, res, ot); if (!s) return;
  const f = planAlanlari(req.body); if (f.hata) return hata(res, 400, f.hata);
  if (await cakisma(ot.egitmenId, f.tarih, f.saat, f.sure, s.ref.id)) return hata(res, 409, 'Bu saatte başka bir dersiniz var.');
  await s.ref.update({ tarih: f.tarih, saat: f.saat, sure: f.sure });
  res.json({ ok: true });
}
async function egitmenPlanSil(req, res, ot) {
  if (ot.ilkGiris) return hata(res, 403, 'Önce şifrenizi değiştirin.');
  const s = await benimPlanSeansi(req, res, ot); if (!s) return;
  await s.ref.delete();
  res.json({ ok: true });
}


// ── Eğitmen yoklaması (yönetim panelindeki yoklama mantığının sunucu karşılığı) ──
const GUN_ESLE = { pazartesi: 1, monday: 1, sali: 2, 'salı': 2, tuesday: 2, carsamba: 3, 'çarşamba': 3, wednesday: 3, persembe: 4, 'perşembe': 4, thursday: 4, cuma: 5, friday: 5, cumartesi: 6, saturday: 6, pazar: 0, sunday: 0 };
const sinifGunNo = (si) => { const g = String(si.gun || '').trim().normalize('NFC').toLowerCase(); return Object.prototype.hasOwnProperty.call(GUN_ESLE, g) ? GUN_ESLE[g] : -1; };
const trBugun = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const tarihGun = (ts) => new Date(ts + 'T00:00:00Z').getUTCDay();
const tarihEkle = (ts, gun) => new Date(new Date(ts + 'T00:00:00Z').getTime() + gun * 86400000).toISOString().slice(0, 10);
const YOKLAMA_HAFTA = 12;

async function yoklamaBaglam(E, sinifId) {
  const sDoc = await db.collection('siniflar').doc(String(sinifId || '_yok')).get();
  if (!sDoc.exists) return { hata: 'Sınıf bulunamadı.' };
  const si = { id: sDoc.id, ...sDoc.data() };
  if (si.egitmenId !== E && si.egitmen2Id !== E) return { hata: 'Bu sınıf size ait değil.' };
  if ((si.durum || 'aktif') === 'pasif') return { hata: 'Sınıf aktif değil.' };
  const [ogSnap, gecSnap, yokSnap, tatSnap] = await Promise.all([
    db.collection('ogrenciler').get(), db.collection('ogrenciGecmisi').get(),
    db.collection('yoklamalar').where('sinifId', '==', si.id).get(), db.collection('tatiller').get(),
  ]);
  const ogMap = {}; ogSnap.docs.forEach((d) => { ogMap[d.id] = { id: d.id, ...d.data() }; });
  return {
    si, ogMap, gecmis: gecSnap.docs.map((d) => d.data()),
    yoklamalar: yokSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    tatiller: new Set(tatSnap.docs.map((d) => d.data().tarih)),
  };
}
function ogOTarihteAktif(B, ogId, tarih) {
  const ol = B.gecmis.filter((g) => g.ogrenciId === ogId && (g.olay === 'aktif' || g.olay === 'pasif')).sort((a, b) => (a.tarih || '').localeCompare(b.tarih || ''));
  if (!ol.length) return ((B.ogMap[ogId] || {}).durum || 'aktif') === 'aktif';
  const gecerli = ol.filter((o) => o.tarih <= tarih);
  if (gecerli.length) return gecerli[gecerli.length - 1].olay === 'aktif';
  return ol[0].olay === 'pasif';
}
function kayitOTarihteDonuk(B, ogId, tarih) {
  const ol = B.gecmis.filter((g) => g.sinifId === B.si.id && g.ogrenciId === ogId && (g.olay === 'dondur' || g.olay === 'coz') && g.tarih <= tarih).sort((a, b) => (a.tarih || '').localeCompare(b.tarih || ''));
  return ol.length ? ol[ol.length - 1].olay === 'dondur' : false;
}
function yoklamaOgrenciIdleri(B, tarih) {
  const set = new Set();
  (B.si.kayitlar || []).forEach((k) => {
    if (!B.ogMap[k.ogrenciId]) return;
    if (k.basTarih && k.basTarih > tarih) return;
    if (kayitOTarihteDonuk(B, k.ogrenciId, tarih)) return;
    if (!ogOTarihteAktif(B, k.ogrenciId, tarih)) return;
    set.add(k.ogrenciId);
  });
  B.gecmis.filter((g) => g.sinifId === B.si.id && g.olay === 'cikis' && g.tarih > tarih).forEach((g) => {
    if (set.has(g.ogrenciId) || (B.si.kayitlar || []).some((k) => k.ogrenciId === g.ogrenciId)) return;
    if (!B.ogMap[g.ogrenciId] || !ogOTarihteAktif(B, g.ogrenciId, tarih)) return;
    set.add(g.ogrenciId);
  });
  B.yoklamalar.filter((y) => y.tarih === tarih && B.ogMap[y.ogrenciId]).forEach((y) => set.add(y.ogrenciId));
  return set;
}
const yoklamaTarihiGecerli = (B, tarih) => TARIH_RE.test(tarih) && tarih <= trBugun() && tarihGun(tarih) === sinifGunNo(B.si)
  && !B.tatiller.has(tarih) && !(B.si.iptalTarihleri || []).includes(tarih);

async function egitmenYoklamaListe(req, res, ot) {
  if (ot.ilkGiris) return hata(res, 403, 'Önce şifrenizi değiştirin.');
  const B = await yoklamaBaglam(ot.egitmenId, req.body.sinifId); if (B.hata) return hata(res, 404, B.hata);
  const gn = sinifGunNo(B.si); if (gn < 0) return res.json({ tarihler: [] });
  let d = trBugun(); while (tarihGun(d) !== gn) d = tarihEkle(d, -1);
  const tarihler = [];
  for (let i = 0; i < YOKLAMA_HAFTA; i++, d = tarihEkle(d, -7)) {
    if (!yoklamaTarihiGecerli(B, d)) continue;
    const idler = [...yoklamaOgrenciIdleri(B, d)];
    if (!idler.length) continue;
    const kayit = B.yoklamalar.filter((y) => y.tarih === d);
    const kaydeden = kayit.map((y) => y.kaydedenAd).filter(Boolean);
    tarihler.push({
      tarih: d, alindi: kayit.length > 0, kaydeden: kaydeden.length ? kaydeden[kaydeden.length - 1] : '',
      gelenler: kayit.map((y) => y.ogrenciId),
      ogrenciler: idler.map((id) => { const o = B.ogMap[id]; return { id, ad: o.ad || '', soyad: o.soyad || '', cinsiyet: o.cinsiyet || '' }; })
        .sort((a, b) => (a.ad + a.soyad).localeCompare(b.ad + b.soyad, 'tr')),
    });
  }
  res.json({ tarihler });
}
async function egitmenYoklamaKaydet(req, res, ot) {
  if (ot.ilkGiris) return hata(res, 403, 'Önce şifrenizi değiştirin.');
  const E = ot.egitmenId, tarih = String(req.body.tarih || '');
  const B = await yoklamaBaglam(E, req.body.sinifId); if (B.hata) return hata(res, 404, B.hata);
  if (TARIH_RE.test(tarih) && tarih > trBugun()) return hata(res, 400, 'Gelecek tarih için yoklama alınamaz.');
  if (!yoklamaTarihiGecerli(B, tarih)) return hata(res, 400, 'Bu tarihte bu sınıfın dersi yok.');
  const izinli = yoklamaOgrenciIdleri(B, tarih);
  const secilen = new Set((Array.isArray(req.body.gelenler) ? req.body.gelenler : []).map(String));
  for (const id of secilen) if (!izinli.has(id)) return hata(res, 400, 'Listede olmayan öğrenci seçildi.');
  const eg = (await db.collection('egitmenler').doc(E).get()).data() || {};
  const ad = eg.ad || 'Eğitmen';
  const mevcut = B.yoklamalar.filter((y) => y.tarih === tarih);
  const batch = db.batch(); let ekle = 0, cikar = 0;
  secilen.forEach((id) => { if (!mevcut.some((y) => y.ogrenciId === id)) { batch.set(db.collection('yoklamalar').doc(), { sinifId: B.si.id, ogrenciId: id, tarih, olusturma: Date.now(), kaydeden: 'egitmen', kaydedenAd: ad, kaydedenId: E }); ekle++; } });
  mevcut.forEach((y) => { if (!secilen.has(y.ogrenciId)) { batch.delete(db.collection('yoklamalar').doc(y.id)); cikar++; } });
  if (ekle || cikar) {
    batch.set(db.collection('yoklama_log').doc(), { sinifId: B.si.id, sinifAdi: B.si.ad || '', tarih, kaydeden: 'egitmen', kaydedenAd: ad, kaydedenId: E, ekle, cikar, gelenSayisi: secilen.size, ilk: mevcut.length === 0, zaman: Date.now() });
    await batch.commit();
  }
  res.json({ ok: true, ekle, cikar });
}

exports.portal = onRequest({ region: 'europe-west1', cors: true, maxInstances: 10, timeoutSeconds: 30 }, async (req, res) => {
  try {
    if (req.method !== 'POST') return hata(res, 405, 'Yalnızca POST.');
    const b = req.body || {};
    if (typeof b !== 'object') return hata(res, 400, 'Geçersiz istek.');
    if (b.islem === 'giris') return await giris(req, res);
    if (b.islem === 'egitmen_giris') return await egitmenGiris(req, res);

    const ot = await oturumBul(b.token);
    if (!ot) return hata(res, 401, 'Oturum süresi doldu. Lütfen tekrar giriş yapın.', { oturum: false });
    // Eğitmen oturumu yalnızca eğitmen işlemlerine, öğrenci oturumu yalnızca öğrenci işlemlerine izin verir
    const egIslem = { e_veri: egitmenVeri, e_sifre: egitmenSifre, e_planla: egitmenPlanla, e_plan_duzenle: egitmenPlanDuzenle, e_plan_sil: egitmenPlanSil, e_yoklama_liste: egitmenYoklamaListe, e_yoklama_kaydet: egitmenYoklamaKaydet };
    if (egIslem[b.islem]) { if (!ot.egitmenId) return hata(res, 403, 'Yetkisiz.'); return await egIslem[b.islem](req, res, ot); }
    if (b.islem !== 'cikis' && !ot.ogrenciId) return hata(res, 403, 'Yetkisiz.');
    if (b.islem === 'veri') return await veri(req, res, ot);
    if (b.islem === 'sifre') return await sifreDegistir(req, res, ot);
    if (b.islem === 'not') return await notGonder(req, res, ot);
    if (b.islem === 'cikis') { await ot.ref.delete(); return res.json({ ok: true }); }
    return hata(res, 400, 'Bilinmeyen işlem.');
  } catch (e) {
    console.error(e);
    return hata(res, 500, 'Sunucu hatası. Lütfen tekrar deneyin.');
  }
});

// ════════════════════════════════════════════════════════════════════
// Öğrenci kayıt formu (herkese açık sayfa: kayit.html)
//   Her bağlantı TEK KULLANIMLIKTIR: kayit_linkleri/{kod}. Kod tahmin edilemez (128 bit).
//   bilgi  : bağlantı geçerliyse form metinlerini döndürür (kod 'onizleme' ise yalnız önizleme)
//   gonder : doğrular, bağlantıyı işlemde "kullanıldı" yapıp başvuruyu yazar, onay kanıtını sunucu tarafında üretir
//   Başvuru `kayit_basvurulari`na "beklemede" yazılır; yönetici uygulamadan onaylar. İstemci bu koleksiyonlara yazamaz.
// ════════════════════════════════════════════════════════════════════
const KAYIT_MAX = { ad: 60, tel: 25, eposta: 120, acil: 160, kisa: 80 };
function ipAl(req) {
  // İlk değer istemci tarafından sahte yazılabilir; Google'ın eklediği son değer güvenilirdir
  const parcalar = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return (parcalar[parcalar.length - 1] || req.ip || '').slice(0, 64);
}
function yasHesapla(dogum) {
  const [y, m, g] = dogum.split('-').map(Number);
  const tr = new Date(Date.now() + 3 * 3600 * 1000); // Türkiye saati
  let yas = tr.getUTCFullYear() - y;
  const ay = tr.getUTCMonth() + 1 - m;
  if (ay < 0 || (ay === 0 && tr.getUTCDate() < g)) yas--;
  return yas;
}
function kayitMetinleri(d) {
  return {
    surum: d.surum || 1,
    aydinlatma: { baslik: String(d.aydinlatma && d.aydinlatma.baslik || ''), metin: String(d.aydinlatma && d.aydinlatma.metin || '') },
    rizalar: (Array.isArray(d.rizalar) ? d.rizalar : []).filter((r) => r && r.aktif !== false).map((r) => ({ id: String(r.id), baslik: String(r.baslik || ''), metin: String(r.metin || ''), kutu: String(r.kutu || '') })),
    kurallar: { baslik: String(d.kurallar && d.kurallar.baslik || ''), metin: String(d.kurallar && d.kurallar.metin || '') },
    veli: { metin: String(d.veli && d.veli.metin || '') },
  };
}
async function kayitMetinOku() {
  const s = await db.collection('ayarlar').doc('kayitFormu').get();
  if (!s.exists) return null;
  return kayitMetinleri(s.data());
}
async function kayitLinkDurum(kod) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(kod)) return { hata: 'Bağlantı geçersiz.', kod: 404 };
  const ref = db.collection('kayit_linkleri').doc(kod);
  const s = await ref.get();
  if (!s.exists) return { hata: 'Bağlantı geçersiz.', kod: 404 };
  const d = s.data();
  if (d.kullanildi) return { hata: 'Bu bağlantı daha önce kullanılmış. Yeni bir bağlantı için stüdyoyla iletişime geçin.', kod: 410 };
  if ((d.bitis || 0) < Date.now()) return { hata: 'Bu bağlantının süresi dolmuş. Yeni bir bağlantı için stüdyoyla iletişime geçin.', kod: 410 };
  return { ref, d };
}
const kTemiz = (s, n) => metinTemizle(s, n);

exports.kayit = onRequest({ region: 'europe-west1', cors: true, maxInstances: 5, timeoutSeconds: 30 }, async (req, res) => {
  try {
    if (req.method !== 'POST') return hata(res, 405, 'Yalnızca POST.');
    const b = req.body || {};
    const ipAnahtar = 'kayitip_' + sha(ipAl(req) || 'bilinmiyor').slice(0, 24);
    if (b.islem === 'bilgi') {
      const metin = await kayitMetinOku();
      if (!metin) return hata(res, 503, 'Form henüz hazırlanmadı.');
      if (b.k === 'onizleme') return res.json({ ok: true, onizleme: true, metin });
      const k1 = await kilitKontrol(ipAnahtar);
      if (k1 > 0) return hata(res, 429, 'Çok fazla deneme. Lütfen biraz sonra tekrar deneyin.');
      const L = await kayitLinkDurum(String(b.k || ''));
      if (L.hata) { await hataKaydet(ipAnahtar, 30); return hata(res, L.kod, L.hata); }
      return res.json({ ok: true, not: L.d.not || '', metin });
    }
    if (b.islem !== 'gonder') return hata(res, 400, 'Bilinmeyen işlem.');
    if (b.k === 'onizleme') return hata(res, 400, 'Bu bir önizlemedir, gönderim yapılamaz.');
    if (typeof b.hp === 'string' && b.hp) return res.json({ ok: true }); // bot tuzağı (gizli alan)

    if ((await kilitKontrol(ipAnahtar)) > 0) return hata(res, 429, 'Çok fazla deneme. Lütfen biraz sonra tekrar deneyin.');
    const L = await kayitLinkDurum(String(b.k || ''));
    if (L.hata) { await hataKaydet(ipAnahtar, 30); return hata(res, L.kod, L.hata); }
    const metin = await kayitMetinOku();
    if (!metin) return hata(res, 503, 'Form henüz hazırlanmadı.');

    const o = b.ogrenci || {};
    const ogr = {
      ad: kTemiz(o.ad, KAYIT_MAX.ad), soyad: kTemiz(o.soyad, KAYIT_MAX.ad), cinsiyet: o.cinsiyet === 'e' ? 'e' : 'k',
      dogum: String(o.dogum || ''), tel: String(o.tel || '').replace(/[^\d+ ]/g, '').slice(0, KAYIT_MAX.tel),
      eposta: kTemiz(o.eposta, KAYIT_MAX.eposta), acil: kTemiz(o.acil, KAYIT_MAX.acil),
    };
    if (!ogr.ad || !ogr.soyad) return hata(res, 400, 'Ad ve soyad zorunludur.');
    if (!TARIH_RE.test(ogr.dogum)) return hata(res, 400, 'Doğum tarihi geçerli olmalı.');
    if (ogr.tel.replace(/\D/g, '').length < 10) return hata(res, 400, 'Geçerli bir telefon numarası girin.');
    if (ogr.eposta && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ogr.eposta)) return hata(res, 400, 'E-posta geçerli değil.');
    const yas = yasHesapla(ogr.dogum);
    if (!(yas >= 0 && yas < 110)) return hata(res, 400, 'Doğum tarihi geçerli değil.');
    const kucuk = yas < 18;
    let veli = null;
    if (kucuk) {
      const v = b.veli || {};
      veli = { ad: kTemiz(v.ad, KAYIT_MAX.ad), yakinlik: kTemiz(v.yakinlik, KAYIT_MAX.kisa), tel: String(v.tel || '').replace(/[^\d+ ]/g, '').slice(0, KAYIT_MAX.tel) };
      if (!veli.ad || !veli.yakinlik || veli.tel.replace(/\D/g, '').length < 10) return hata(res, 400, 'Öğrenci 18 yaşından küçük: veli/vasi adı, yakınlığı ve telefonu zorunludur.');
    }
    const on = b.onaylar || {};
    if (on.aydinlatma !== true) return hata(res, 400, 'Aydınlatma metnini okuduğunuzu onaylamalısınız.');
    if (on.kural !== true) return hata(res, 400, 'Okul kurallarını kabul etmelisiniz.');
    if (kucuk && on.veli !== true) return hata(res, 400, 'Veli/vasi beyanını onaylamalısınız.');
    const rizaDurum = {}, rizaOzet = {};
    metin.rizalar.forEach((r) => { rizaDurum[r.id] = !!(on.rizalar && on.rizalar[r.id] === true); rizaOzet[r.id] = sha(r.baslik + '\n' + r.metin + '\n' + r.kutu); });
    const cz = b.cihaz || {};
    const simdi = Date.now();
    const kanit = {
      sunucuZamani: simdi, sunucuZamaniISO: new Date(simdi).toISOString(),
      ip: ipAl(req), ipZinciri: String(req.headers['x-forwarded-for'] || '').slice(0, 200), userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      dil: kTemiz(cz.dil, 20), saatDilimi: kTemiz(cz.tz, 50), ekran: kTemiz(cz.ekran, 20), istemciSaati: kTemiz(cz.saat, 40),
      metinSurum: metin.surum,
      ozetler: { aydinlatma: sha(metin.aydinlatma.baslik + '\n' + metin.aydinlatma.metin), kurallar: sha(metin.kurallar.baslik + '\n' + metin.kurallar.metin), veli: sha(metin.veli.metin), rizalar: rizaOzet },
      linkOzet: sha(String(b.k)).slice(0, 16),
    };
    const bas = db.collection('kayit_basvurulari').doc();
    await db.runTransaction(async (tx) => {
      const s = await tx.get(L.ref);
      const d = s.data() || {};
      if (!s.exists || d.kullanildi || (d.bitis || 0) < simdi) { const e = new Error('KULLANILMIS'); e.kullanilmis = true; throw e; }
      tx.update(L.ref, { kullanildi: true, kullanimZamani: simdi, basvuruId: bas.id });
      tx.set(bas, {
        durum: 'beklemede', olusturma: simdi, linkNot: d.not || '',
        ogrenci: ogr, kucuk, veli,
        onaylar: { aydinlatma: true, kural: true, veli: kucuk ? true : null, rizalar: rizaDurum },
        metinKopya: metin, kanit,
      });
    });
    return res.json({ ok: true });
  } catch (e) {
    if (e && e.kullanilmis) return hata(res, 410, 'Bu bağlantı daha önce kullanılmış.');
    console.error(e);
    return hata(res, 500, 'Sunucu hatası. Lütfen tekrar deneyin.');
  }
});
