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
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const OTURUM_SURESI_MS = 12 * 60 * 60 * 1000;      // 12 saat
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
async function oturumAc(ogrenciId, ilkGiris) {
  const anahtar = crypto.randomBytes(32).toString('hex');
  await db.collection('portal_oturum').doc(sha(anahtar)).set({
    ogrenciId, ilkGiris: !!ilkGiris, exp: Date.now() + OTURUM_SURESI_MS, olusturma: Date.now(),
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
  const og = ogSnap.docs.map((d) => ({ id: d.id, ...d.data() })).find((o) => son10(o.tel) === tel);
  // Kullanıcı var/yok bilgisini sızdırmamak için aynı hata
  const GENEL = 'Telefon numarası veya şifre hatalı.';
  if (!og) { await hataKaydet(ipAnahtar, IP_ESIK); return hata(res, 401, GENEL); }

  const hesapRef = db.collection('ogrenci_hesaplar').doc(og.id);
  const hesap = await hesapRef.get();
  const h = hesap.exists ? hesap.data() : {};
  let dogru = false, ilkGiris = false;

  if (h.hash && h.tuz) {
    dogru = sifreDogruMu(sifre, h);
  } else if (h.sifre) {
    // Eski düz metin şifre: doğrulanırsa özetli forma çevir, düz metni sil
    dogru = String(h.sifre) === sifre;
    if (dogru) {
      const o = sifreOzetle(sifre);
      await hesapRef.set({ hash: o.hash, tuz: o.tuz, guncelleme: Date.now() });
    }
  } else {
    // Hiç şifre belirlenmemiş: ilk şifre telefonun son 4 hanesi, ilk girişte değiştirilmek zorunda
    dogru = sifre === son4(og.tel);
    ilkGiris = true;
  }

  if (!dogru) {
    await hataKaydet(ipAnahtar, IP_ESIK); await hataKaydet(telAnahtar);
    return hata(res, 401, GENEL);
  }
  await kilitSifirla(telAnahtar);
  const anahtar = await oturumAc(og.id, ilkGiris);
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
  const [siniflarSnap, odemeler, yoklamalar, ozelPaketler, ozelSeanslar, ogrenciGecmisi, tatillerSnap, egitSnap, obSnap] = await Promise.all([
    db.collection('siniflar').get(), q('odemeler'), q('yoklamalar'), q('ozelPaketler'), q('ozelSeanslar'), q('ogrenciGecmisi'),
    db.collection('tatiller').get(), db.collection('egitmenler').get(), db.collection('ayarlar').doc('odemeBilgileri').get(),
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
    egitmenler, notlarim, odemeBilgileri: obSnap.exists ? obSnap.data() : null,
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

exports.portal = onRequest({ region: 'europe-west1', cors: true, maxInstances: 10, timeoutSeconds: 30 }, async (req, res) => {
  try {
    if (req.method !== 'POST') return hata(res, 405, 'Yalnızca POST.');
    const b = req.body || {};
    if (typeof b !== 'object') return hata(res, 400, 'Geçersiz istek.');
    if (b.islem === 'giris') return await giris(req, res);

    const ot = await oturumBul(b.token);
    if (!ot) return hata(res, 401, 'Oturum süresi doldu. Lütfen tekrar giriş yapın.', { oturum: false });
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
