// OTOMATİK ÜRETİLDİ — elle düzenlemeyin. Kaynak: index.html (tools/hesap-uret.js ile yeniden üretilir)
'use strict';
process.env.TZ = 'Europe/Istanbul'; // uygulama stüdyonun yerel saatine göre hesaplar
let S = { odemeler: [], egitmenler: [], ogrenciler: [], siniflar: [], tatiller: [], ogrenciGecmisi: [] };
let GIDER_AYARLARI = {};
const LANG = 'tr';
function t(k) { return k; }

function simdikiZaman(){return new Date();}

function ogrenciDonukAraliklariniHesapla(ogId,siId){
  const olaylar=S.ogrenciGecmisi
    .filter(g=>g.ogrenciId===ogId&&g.sinifId===siId&&(g.olay==='dondur'||g.olay==='coz')&&g.tarih)
    .sort((a,b)=>a.tarih.localeCompare(b.tarih)||(a.olusturma||0)-(b.olusturma||0));
  const araliklar=[];
  let acikBaslangic=null;
  olaylar.forEach(g=>{
    if(g.olay==='dondur'){
      if(acikBaslangic==null)acikBaslangic=g.tarih; // zaten dondurulmuşsa yinelenen olayı yok say
    } else if(g.olay==='coz'){
      if(acikBaslangic!=null){araliklar.push([acikBaslangic,g.tarih]);acikBaslangic=null;}
    }
  });
  if(acikBaslangic!=null){
    // Hâlâ dondurulmuş (çözülmemiş) — ileriye açık, ama nDersSonra/nDersTarihleri'nin
    // haftalık arama döngüsü sonsuza kadar (yıl 9999'a kadar!) dönmesin diye makul
    // bir ufuk (bugünden 2 yıl) ile sınırlıyoruz. Çözüldüğü an gerçek "çöz" tarihi
    // bu sınırın yerini alır ve tarihler doğru şekilde yeniden hesaplanır.
    const simdi=simdikiZaman();
    const sinir=new Date(simdi.getFullYear()+2,simdi.getMonth(),simdi.getDate());
    const sinirStr=sinir.getFullYear()+'-'+String(sinir.getMonth()+1).padStart(2,'0')+'-'+String(sinir.getDate()).padStart(2,'0');
    araliklar.push([acikBaslangic,sinirStr]);
  }
  return araliklar;
}

function tarihDondurulmusMu(araliklar,tarihStr){
  return araliklar.some(([b,s])=>tarihStr>=b&&tarihStr<s);
}

function odemeDersSayisi(od){
  if(od&&od.odTip==='tekders')return 1;
  const aySayisi=(od&&od.aylar||[]).length>0?od.aylar.length:1;
  return aySayisi*4;
}

function hesaplaOdemeDersTarihleri(ogId,siId,iadeUygula=true){
  const si=S.siniflar.find(s=>s.id===siId);
  if(!si)return[];
  const ods=S.odemeler.filter(o=>o.ogrenciId===ogId&&o.sinifId===siId);
  const k=(si.kayitlar||[]).find(x=>x.ogrenciId===ogId);
  // Öğrenci bu sınıftan ayrılmış olabilir (sınıf değiştirme/birleştirme sonrası
  // kayıt kaldırılır), ama GEÇMİŞ ödemeleri hâlâ bu sınıfa ait ve hakediş
  // hesaplarında (sinifGelirDonemProrated/sinifGelirAyProrated) doğru şekilde
  // sayılmaya devam etmeli. Böyle durumlarda ogrenciSinifDegistirOdemeleriBol'un
  // ödeme kaydına işlediği paketTipi bayrağına bakılır.
  const paketMi=k?k.tip==='paket':ods.some(o=>o.paketTipi===true);
  if(!paketMi)return[]; // paket dışı kayıtlarda ders bazlı tarih takibi yok

  const siraliOd=ods.filter(o=>o.tarih).sort((a,b)=>a.tarih.localeCompare(b.tarih));
  if(!siraliOd.length)return[];

  const gunNoTespit=sinifGunNo(si);
  const dersGunu=gunNoTespit>=0?gunNoTespit:1;
  const tatilSet=new Set([...(S.tatiller||[]).map(t=>t.tarih),...((si&&si.iptalTarihleri)||[])]);
  const donukAraliklari=ogrenciDonukAraliklariniHesapla(ogId,siId);

  function dateStr(t){
    const y=t.getFullYear(),m=String(t.getMonth()+1).padStart(2,'0'),d=String(t.getDate()).padStart(2,'0');
    return y+'-'+m+'-'+d;
  }
  function gecersiz(tarihStr){return tatilSet.has(tarihStr)||tarihDondurulmusMu(donukAraliklari,tarihStr);}
  function ilkDersGunu(tarihStr){
    const parts=tarihStr.split('-');
    const t=new Date(+parts[0],+parts[1]-1,+parts[2]);
    const fark=(dersGunu-t.getDay()+7)%7;
    t.setDate(t.getDate()+fark);
    return t;
  }
  // nDersSonra ile birebir aynı ilerleme mantığı, ama sadece son tarihi değil
  // yol boyunca geçtiği TÜM geçerli (tatil olmayan VE dondurulmamış) ders
  // tarihlerini toplar.
  function nDersTarihleri(bas,n){
    const liste=[];
    const t=new Date(bas.getFullYear(),bas.getMonth(),bas.getDate());
    while(gecersiz(dateStr(t))){t.setDate(t.getDate()+7);}
    liste.push(dateStr(t));
    let sayac=1;
    while(sayac<n){
      t.setDate(t.getDate()+7);
      if(!gecersiz(dateStr(t))){sayac++;liste.push(dateStr(t));}
    }
    return{liste,sonTarih:new Date(t.getFullYear(),t.getMonth(),t.getDate())};
  }

  const sonuc=[];
  let zincirBitis=null;
  for(const od of siraliOd){
    const aySayisi=(od.aylar||[]).length>0?od.aylar.length:1;
    // bkz. hesaplaKayit'teki aynı isimli yorum — bölünmüş ödemelerde dönem
    // sayısı × 4 gerçek ders sayısını yansıtmayabilir, dersSayisiOzel varsa
    // onu kullan.
    const dersSayisiHam=od.dersSayisiOzel!=null?od.dersSayisiOzel:odemeDersSayisi(od);
    // İade edilmiş kalan dersler (bkz. ogrenciIadeHesapla): ödemenin kapsadığı
    // ders sayısından düşülür, tutardan da iade tutarı düşülür — böylece ders
    // başı ücret aynı kalır, ama iade edilen dersler hakedişe hiç yansımaz.
    const iadeDers=(iadeUygula&&od.iade&&od.iade.ders)||0;
    const dersSayisi=dersSayisiHam-iadeDers;
    if(dersSayisi<=0)continue; // tamamen iade edilmiş ödeme: ders de gelir de yok
    let donemBas;
    if(!zincirBitis){
      donemBas=ilkDersGunu(od.tarih);
    } else {
      const odemeIlkDers=ilkDersGunu(od.tarih);
      if(odemeIlkDers.getTime()===zincirBitis.getTime()){
        donemBas=new Date(zincirBitis);
      } else if(odemeIlkDers<zincirBitis){
        donemBas=new Date(zincirBitis.getFullYear(),zincirBitis.getMonth(),zincirBitis.getDate());
        donemBas.setDate(donemBas.getDate()+7);
        while(gecersiz(dateStr(donemBas)))donemBas.setDate(donemBas.getDate()+7);
      } else {
        donemBas=odemeIlkDers;
      }
    }
    const{liste,sonTarih}=nDersTarihleri(donemBas,dersSayisi);
    sonuc.push({od:(iadeUygula&&od.iade)?{...od,tutar:(od.tutar||0)-(od.iade.tutar||0)}:od,tarihler:liste});
    zincirBitis=sonTarih;
  }
  return sonuc;
}

function sinifIlgiliOgrenciIdleri(si){
  const set=new Set((si.kayitlar||[]).map(k=>k.ogrenciId));
  S.odemeler.forEach(o=>{if(o.sinifId===si.id)set.add(o.ogrenciId);});
  return set;
}

function sinifKiraTarihte(si,tarihStr){
  if(si.kira)return si.kira;
  const gecmis=(GIDER_AYARLARI&&GIDER_AYARLARI.grupKiraGecmisi)||[];
  if(!gecmis.length)return 0;
  const siralı=gecmis.slice().sort((a,b)=>a.tarih.localeCompare(b.tarih));
  let uygun=null;
  for(const g of siralı){ if(g.tarih<=tarihStr)uygun=g; else break; }
  return uygun?(uygun.tutar||0):(siralı[0].tutar||0);
}

function pratikKiraTarihte(tarihStr){
  const gecmis=(GIDER_AYARLARI&&GIDER_AYARLARI.pratikKiraGecmisi)||[];
  if(!gecmis.length)return {saat:0,saatlikUcret:0};
  const siralı=gecmis.slice().sort((a,b)=>a.tarih.localeCompare(b.tarih));
  let uygun=null;
  for(const g of siralı){ if(g.tarih<=tarihStr)uygun=g; else break; }
  const kayit=uygun||siralı[0];
  return {saat:kayit.saat||0,saatlikUcret:kayit.saatlikUcret||0};
}

function pratikCumartesiSayisi(bas,bitis){
  const iptaller=new Set((GIDER_AYARLARI&&GIDER_AYARLARI.pratikIptalTarihleri)||[]);
  let sayac=0;
  const d=new Date(bas);
  while(d<=bitis){
    if(d.getDay()===6){
      const ds=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      if(!iptaller.has(ds))sayac++;
    }
    d.setDate(d.getDate()+1);
  }
  return sayac;
}

const DONEM_GUN=28;

function sinifDonemBaslangic(si){
  if(si.donemBaslangic)return si.donemBaslangic;
  // Alan boşsa (eski sınıflar), sabit bir tarihe ihtiyaç var — her seferinde
  // "bugün" kullanırsak dönemler her gün kayar. Onun yerine o sınıfın en eski
  // ödeme tarihini kullanıyoruz; hiç ödeme yoksa bugünün tarihine düşüyoruz.
  const ods=S.odemeler.filter(o=>o.sinifId===si.id&&o.tarih);
  if(ods.length){
    return ods.reduce((min,o)=>o.tarih<min?o.tarih:min,ods[0].tarih);
  }
  return bugunTarih();
}

function sinifDonemIndex(si,tarihStr){
  const bas=new Date(sinifDonemBaslangic(si)+'T00:00:00');
  const t=new Date(tarihStr+'T00:00:00');
  const gunFarki=Math.floor((t-bas)/864e5);
  return Math.floor(gunFarki/DONEM_GUN);
}

function sinifDonemAraligi(si,idx){
  const bas=new Date(sinifDonemBaslangic(si)+'T00:00:00');
  const donemBas=new Date(bas);donemBas.setDate(donemBas.getDate()+idx*DONEM_GUN);
  const donemBitis=new Date(donemBas);donemBitis.setDate(donemBitis.getDate()+DONEM_GUN-1);
  return{bas:donemBas,bitis:donemBitis};
}

function sinifGuncelDonemIndex(si){
  const simdi=simdikiZaman();
  const s=simdi.getFullYear()+'-'+String(simdi.getMonth()+1).padStart(2,'0')+'-'+String(simdi.getDate()).padStart(2,'0');
  return sinifDonemIndex(si,s);
}

function sinifIadeEtkisiDonem(si,donemIdx){
  const kalemler=[];
  sinifIlgiliOgrenciIdleri(si).forEach(ogId=>{
    const ods=S.odemeler.filter(o=>o.ogrenciId===ogId&&o.sinifId===si.id);
    if(!ods.some(o=>o.iade))return;
    const k=(si.kayitlar||[]).find(x=>x.ogrenciId===ogId);
    const paketMi=k?k.tip==='paket':ods.some(o=>o.paketTipi===true);
    if(!paketMi)return;
    const pay=(iadeUygula)=>{
      let t=0;
      hesaplaOdemeDersTarihleri(ogId,si.id,iadeUygula).forEach(({od,tarihler})=>{
        if(!tarihler.length)return;
        const n=tarihler.filter(d=>sinifDonemIndex(si,d)===donemIdx).length;
        if(n>0)t+=(od.tutar||0)*(n/tarihler.length);
      });
      return t;
    };
    const fark=Math.round(pay(false)-pay(true));
    if(fark>0){
      const og=S.ogrenciler.find(o=>o.id===ogId);
      kalemler.push({ad:og?((og.ad||'')+' '+((og.soyad||'')[0]||'')+'.').trim():'?',tutar:fark});
    }
  });
  return{toplam:kalemler.reduce((a,x)=>a+x.tutar,0),kalemler};
}

function sinifGelirDonemProrated(si,donemIdx){
  let toplam=0;
  sinifIlgiliOgrenciIdleri(si).forEach(ogId=>{
    const k=(si.kayitlar||[]).find(x=>x.ogrenciId===ogId);
    const ods=S.odemeler.filter(o=>o.ogrenciId===ogId&&o.sinifId===si.id);
    const paketMi=k?k.tip==='paket':ods.some(o=>o.paketTipi===true);
    if(!paketMi){
      ods.forEach(o=>{
        if(!o.tarih)return;
        if(sinifDonemIndex(si,o.tarih)===donemIdx)toplam+=(o.tutar||0);
      });
      return;
    }
    const dagilim=hesaplaOdemeDersTarihleri(ogId,si.id);
    dagilim.forEach(({od,tarihler})=>{
      if(!tarihler.length)return;
      const buDonemSayisi=tarihler.filter(d=>sinifDonemIndex(si,d)===donemIdx).length;
      if(buDonemSayisi>0)toplam+=(od.tutar||0)*(buDonemSayisi/tarihler.length);
    });
  });
  return Math.round(toplam);
}

function bugunTarih(){const d=simdikiZaman();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}

const GUN_MAP={
  'pazartesi':1,'salı':2,'çarşamba':3,'perşembe':4,
  'cuma':5,'cumartesi':6,'pazar':0
};

function sinifGunNo(si){
  let g=(si.gun||'').trim();
  if(g.normalize)g=g.normalize('NFC'); // farklı klavye/kaynaklardan gelen Unicode kodlama farklarını eşitle
  g=g.toLowerCase();
  const esnekMap={
    'pazartesi':1,'monday':1,
    'sali':2,'salı':2,'tuesday':2,
    'carsamba':3,'çarşamba':3,'wednesday':3,
    'persembe':4,'perşembe':4,'thursday':4,
    'cuma':5,'friday':5,
    'cumartesi':6,'saturday':6,
    'pazar':0,'sunday':0,
  };
  if(esnekMap.hasOwnProperty(g))return esnekMap[g];
  return GUN_MAP[g]??-1;
}

function sinifDonemPayHesapla(si,donemIdx,aktifSinifSayisi){
  const egitmen=S.egitmenler.find(e=>e.id===si.egitmenId);
  const egitmen2=S.egitmenler.find(e=>e.id===si.egitmen2Id);
  const asistanPct=(si.asistanPct||0)/100;
  const asistan2Pct=(si.asistan2Pct||0)/100;

  // Eğitmen payı hesaplaması, TAKVİM AYINA göre değil sınıfın KENDİ döneminin
  // (Dönem Başlangıç Tarihi'nden itibaren 4 haftalık bloklar) hangi bloğu
  // gösteriliyorsa ona göre, o dönemde GERÇEKTEN verilen derslere göre yapılır.
  const donemAralik=sinifDonemAraligi(si,donemIdx);
  const sinifGelir=sinifGelirDonemProrated(si,donemIdx);
  // Kira da o dönemde GEÇERLİ OLAN tutar üzerinden hesaplanır (kira geçmişi
  // varsa) — kira sonradan artmışsa eski dönemler eski tutarla hesaplanır.
  const donemBasStr=donemAralik.bas.getFullYear()+'-'+String(donemAralik.bas.getMonth()+1).padStart(2,'0')+'-'+String(donemAralik.bas.getDate()).padStart(2,'0');
  const kira=sinifKiraTarihte(si,donemBasStr);
  // Cumartesi pratik kirası — STÜDYO KİRASIYLA TAMAMEN AYNI MANTIK: bu da
  // önceliklidir, eğitmenlere pay dağıtılmadan ÖNCE toplam gelirden düşülür.
  // 28 günlük dönem normalde tam 4 Cumartesi içerir, ama pratiğin yapılmadığı
  // (tatil, iptal vb.) Cumartesiler "Eğitmenler & Giderler" bölümünden
  // işaretlenebilir — o hafta için ücret hesaba katılmaz.
  // Dönemin GEÇERLİ tarihindeki (kira geçmişiyle aynı mantık) saat×saatlik
  // ücret tutarı, gerçekleşen Cumartesi sayısıyla çarpılıp aktif tüm grup
  // sınıfları arasında eşit bölünür.
  const pratikBilgi=pratikKiraTarihte(donemBasStr);
  const pratikCumartesiSay=pratikCumartesiSayisi(donemAralik.bas,donemAralik.bitis);
  const pratikDonemTutari=(pratikBilgi.saat||0)*(pratikBilgi.saatlikUcret||0)*pratikCumartesiSay;
  const pratikPay=aktifSinifSayisi>0?Math.round(pratikDonemTutari/aktifSinifSayisi):0;
  const kiraToplam=kira+pratikPay;

  if(!sinifGelir&&!kiraToplam)return null;

  let asistanOdeme=0;
  let asistanAd=null;
  let asistan2Odeme=0;
  let asistan2Ad=null;
  let basEgitmenKar=0;
  let karPaylari=[]; // [{egitmenId, ad, tutar}] — bu sınıfın kâr/kalan tutarının kime ne kadar gittiği
  const ikiBasEgitmen=!!(egitmen&&egitmen.basEgitmen&&egitmen2&&egitmen2.basEgitmen);

  if(ikiBasEgitmen){
    // İki baş eğitmen birlikte atanmış — form bu durumda yüzde sormaz,
    // kira (+ pratik kirası) düştükten sonra kalan TAMAMI ikisi arasında
    // her zaman %50-%50 bölünür (tek baş eğitmende olduğu gibi, burada da
    // yüzde girilmez).
    const kalanKiraSonrasi=Math.max(0,sinifGelir-kiraToplam);
    const pay1=Math.round(kalanKiraSonrasi/2);
    const pay2=kalanKiraSonrasi-pay1;
    karPaylari=[{egitmenId:egitmen.id,ad:egitmen.ad,tutar:pay1},{egitmenId:egitmen2.id,ad:egitmen2.ad,tutar:pay2}];
    basEgitmenKar=kalanKiraSonrasi;
  } else {
    const kalanKiraSonrasi=Math.max(0,sinifGelir-kiraToplam);
    if(egitmen&&!egitmen.basEgitmen){
      // Asistan ders veriyor — KİRA (+ PRATİK KİRASI) ÖNCELİKLİDİR, önce
      // toplam gelirden düşülür. Kalan tutar üzerinde asistan(lar)ın hedef
      // yüzdeleri hesaplanır.
      const denenenOdeme=Math.round(sinifGelir*asistanPct);
      asistanAd=egitmen.ad;
      if(egitmen2&&asistan2Pct>0){
        // İkinci eğitmen de kendi yüzdesi kadar sabit bir pay istiyor — o da
        // asistan1 kadar önceliklidir, biri diğerinin önüne geçmez. Kalan
        // tutar ikisinin istediği toplamı karşılamıyorsa, ORANLI olarak
        // (istedikleri tutarlar oranında) bölüşülür.
        const denenenOdeme2=Math.round(sinifGelir*asistan2Pct);
        const toplamIstenilen=denenenOdeme+denenenOdeme2;
        if(toplamIstenilen<=kalanKiraSonrasi){
          asistanOdeme=denenenOdeme;
          asistan2Odeme=denenenOdeme2;
        } else if(toplamIstenilen>0){
          asistanOdeme=Math.round(kalanKiraSonrasi*(denenenOdeme/toplamIstenilen));
          asistan2Odeme=kalanKiraSonrasi-asistanOdeme;
        }
        asistan2Ad=egitmen2.ad;
        basEgitmenKar=kalanKiraSonrasi-asistanOdeme-asistan2Odeme;
      } else {
        asistanOdeme=Math.min(denenenOdeme,kalanKiraSonrasi);
        basEgitmenKar=kalanKiraSonrasi-asistanOdeme;
      }
    } else {
      // Baş eğitmen veya eğitmen atanmamış — kalan tutarın tamamı önce onun
      // (ya da sahipsizse "stüdyo"nun) kârı sayılır; ikinci eğitmen (varsa)
      // buradan sabit yüzdesi kadar pay alır, kalanı baş eğitmen alır.
      basEgitmenKar=kalanKiraSonrasi;
      if(egitmen2&&asistan2Pct>0){
        const kalanIkinciIcin=Math.max(0,basEgitmenKar);
        const denenenOdeme2=Math.round(sinifGelir*asistan2Pct);
        asistan2Odeme=Math.min(denenenOdeme2,kalanIkinciIcin);
        asistan2Ad=egitmen2.ad;
        basEgitmenKar-=asistan2Odeme;
      }
    }
    karPaylari=[{egitmenId:(egitmen&&egitmen.basEgitmen)?egitmen.id:null,ad:(egitmen&&egitmen.basEgitmen)?egitmen.ad:null,tutar:basEgitmenKar}];
  }

  return {
    si, egitmen, egitmen2, sinifGelir, iade:sinifIadeEtkisiDonem(si,donemIdx), kira, pratikPay,
    asistanOdeme, asistanAd, asistanPct: si.asistanPct||0,
    asistan2Odeme, asistan2Ad, asistan2Pct: si.asistan2Pct||0,
    ikiBasEgitmen, karPaylari,
    basEgitmenKar: basEgitmenKar,
    donemIdx, donemAralik
  };
}

function _tarihStr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

/**
 * Her eğitmen için SADECE kendi payını döndürür: { egitmenId: [ {id, ad, gun, saat, guncelIdx, donemler:[{i,bas,bitis,pay}]} ] }
 * Kira, öğrenci ödemesi, sınıf geliri ve diğer eğitmenin payı çıktıya girmez.
 */
function gelirHesapla(veri) {
  S = {
    odemeler: veri.odemeler || [], egitmenler: veri.egitmenler || [], ogrenciler: veri.ogrenciler || [],
    siniflar: veri.siniflar || [], tatiller: veri.tatiller || [], ogrenciGecmisi: veri.ogrenciGecmisi || [],
  };
  GIDER_AYARLARI = Object.assign({ kira: 0, basEgitmenPayPct: 30, grupKiraGecmisi: [], pratikKiraGecmisi: [], pratikIptalTarihleri: [], ozelKiraGecmisi: [] }, veri.giderAyarlari || {});
  const aktifler = S.siniflar.filter((si) => (si.durum || 'aktif') !== 'pasif');
  const aktifSay = aktifler.length;
  const harita = {};
  aktifler.forEach((si) => {
    const g = sinifGuncelDonemIndex(si);
    for (let idx = Math.max(0, g - 12); idx <= g + 3; idx++) {
      const d = sinifDonemPayHesapla(si, idx, aktifSay);
      const al = sinifDonemAraligi(si, idx);
      const pay = {};
      const ekle = (id, tt) => { if (id) pay[id] = (pay[id] || 0) + (tt || 0); };
      if (d) {
        (d.karPaylari || []).forEach((kp) => ekle(kp.egitmenId, kp.tutar));
        if (d.egitmen && !d.egitmen.basEgitmen) ekle(d.egitmen.id, d.asistanOdeme);
        if (d.egitmen2 && !d.ikiBasEgitmen) ekle(d.egitmen2.id, d.asistan2Odeme);
      }
      [si.egitmenId, si.egitmen2Id].filter(Boolean).forEach((eid) => {
        const m = (harita[eid] = harita[eid] || {});
        const k = (m[si.id] = m[si.id] || { id: si.id, ad: si.ad, gun: si.gun || '', saat: si.saat || '', guncelIdx: g, donemler: [] });
        k.donemler.push({ i: idx, bas: _tarihStr(al.bas), bitis: _tarihStr(al.bitis), pay: Math.round(pay[eid] || 0) });
      });
    }
  });
  const sonuc = {};
  Object.keys(harita).forEach((e) => { sonuc[e] = Object.values(harita[e]); });
  return sonuc;
}
module.exports = { gelirHesapla };
