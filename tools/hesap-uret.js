/**
 * functions/hesap.js üretici.
 * Eğitmen gelir hesabı, yönetici uygulamasındaki (index.html) hesapla BİREBİR aynı olmalı. Hesap kodunu elle kopyalamak yerine
 * index.html'deki ilgili fonksiyonlar (sinifDonemPayHesapla ve bağımlıları) otomatik ayıklanıp functions/hesap.js'e yazılır.
 * index.html'de kira/gelir/dönem hesabı değişirse şunu çalıştırın:   cd tools && npm i --no-save acorn acorn-walk && node hesap-uret.js
 */
const acorn = require('acorn'), walk = require('acorn-walk'), fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script' });
const top = new Map();
for (const n of ast.body) {
  if (n.type === 'FunctionDeclaration') top.set(n.id.name, n);
  else if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => { if (d.id.type === 'Identifier') top.set(d.id.name, n); });
}
const refs = (node) => { const s = new Set(); walk.full(node, (x) => { if (x.type === 'Identifier') s.add(x.name); }); return s; };
const DISARIDA = new Set(['S', 'GIDER_AYARLARI', 'LANG', 'TRANSLATIONS', 't']); // sunucuda kendi tanımlarımız var
const kok = ['sinifDonemPayHesapla', 'sinifGuncelDonemIndex', 'sinifDonemAraligi'];
const inc = new Set(), q = [...kok];
while (q.length) {
  const nm = q.pop();
  if (inc.has(nm) || DISARIDA.has(nm)) continue;
  const n = top.get(nm); if (!n) continue;
  inc.add(nm);
  for (const r of refs(n)) if (top.has(r) && !inc.has(r)) q.push(r);
}
const nodes = [...new Set([...inc].map((n) => top.get(n)))].sort((a, b) => a.start - b.start);
const govde = nodes.map((n) => src.slice(n.start, n.end)).join('\n\n');

const cikti = `// OTOMATİK ÜRETİLDİ — elle düzenlemeyin. Kaynak: index.html (tools/hesap-uret.js ile yeniden üretilir)
'use strict';
process.env.TZ = 'Europe/Istanbul'; // uygulama stüdyonun yerel saatine göre hesaplar
let S = { odemeler: [], egitmenler: [], ogrenciler: [], siniflar: [], tatiller: [], ogrenciGecmisi: [] };
let GIDER_AYARLARI = {};
const LANG = 'tr';
function t(k) { return k; }

${govde}

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
`;
fs.writeFileSync(path.join(__dirname, '..', 'functions', 'hesap.js'), cikti);
console.log('functions/hesap.js üretildi:', [...inc].length, 'öğe');
