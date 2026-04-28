'use strict';
const axios  = require('axios');
const cfg    = require('../../config');
const { sendButtons } = require('./helper');

// ── Sessions: only used when user TYPES (not button taps) ────
// Button taps go through normal command flow via encoded IDs.
const ppSessions = new Map();

// ── Data ──────────────────────────────────────────────────────
const GRADE_SUBJECTS = {
  '6':  ['Sinhala','English','Maths','Science','History','Religion','Geography','Art'],
  '7':  ['Sinhala','English','Maths','Science','History','Religion','Geography','ICT'],
  '8':  ['Sinhala','English','Maths','Science','History','Religion','Geography','ICT'],
  '9':  ['Sinhala','English','Maths','Science','History','Civics','ICT','Commerce'],
  '10': ['Sinhala','English','Maths','Science','History','Civics','ICT','Commerce'],
  'ol': ['Sinhala','English','Maths','Science','History','ICT','Commerce','Religion'],
  'al': ['Physics','Chemistry','Biology','Combined Maths','Economics','Accounting','History','ICT'],
};

function normalizeGrade(s) {
  if (!s) return null;
  const v = s.toLowerCase().replace(/[\s-]/g,'');
  if (['ol','o/l','ordinary','grade11','g11','11'].includes(v)) return 'ol';
  if (['al','a/l','advanced','grade13','g13','13','grade12','g12','12'].includes(v)) return 'al';
  const mm = v.match(/^(?:grade|g)?(\d+)$/);
  if (mm) { const n=parseInt(mm[1],10); if (n>=6&&n<=10) return String(n); }
  return null;
}

const SUBJECT_MAP = {
  sinhala:'Sinhala',si:'Sinhala',sinhalese:'Sinhala',
  english:'English',en:'English',eng:'English',
  maths:'Maths',math:'Maths',mathematics:'Maths',
  science:'Science',sci:'Science',
  history:'History',hist:'History',
  geography:'Geography',geo:'Geography',
  ict:'ICT',it:'ICT',computer:'ICT',
  religion:'Religion',buddhism:'Religion',
  art:'Art',civics:'Civics',civic:'Civics',
  commerce:'Commerce',comm:'Commerce',
  physics:'Physics',phy:'Physics',
  chemistry:'Chemistry',chem:'Chemistry',
  biology:'Biology',bio:'Biology',
  accounting:'Accounting',acc:'Accounting',
  economics:'Economics',econ:'Economics',
  'combined maths':'Combined Maths',combinedmaths:'Combined Maths',combmaths:'Combined Maths',
};
function normalizeSubject(s) { return s ? SUBJECT_MAP[s.toLowerCase().trim()] || null : null; }

const MEDIUM_MAP = {
  sinhala:'Sinhala',si:'Sinhala',sinhalese:'Sinhala',s:'Sinhala',
  english:'English',en:'English',eng:'English',e:'English',
  tamil:'Tamil',ta:'Tamil',tam:'Tamil',t:'Tamil',
};
function normalizeMedium(s) { return s ? MEDIUM_MAP[s.toLowerCase().trim()] || null : null; }

function validateYear(s) {
  const y=parseInt((s||'').trim(),10);
  return (y>=2000&&y<=new Date().getFullYear()) ? y : null;
}

function gradeLabel(g) {
  if (g==='ol') return 'O/L (Grade 11)';
  if (g==='al') return 'A/L (Grade 12/13)';
  return `Grade ${g}`;
}

// ── Subject buttons → IDs encode grade + subject ──────────────
function subjectButtons(grade, subs) {
  return subs.slice(0,4).map(s=>({
    label: `📖 ${s}`,
    id:    `.passpaper ${grade} ${s.toLowerCase()}`,
  }));
}

// ── Medium buttons → IDs encode grade + subject + medium ──────
function mediumButtons(grade, subject) {
  const sl = subject.toLowerCase();
  return [
    { label:'🇱🇰 Sinhala', id:`.passpaper ${grade} ${sl} sinhala` },
    { label:'🇬🇧 English', id:`.passpaper ${grade} ${sl} english` },
    { label:'🇮🇳 Tamil',   id:`.passpaper ${grade} ${sl} tamil`   },
  ];
}

// ── Year buttons → IDs encode grade + subject + medium + year ─
function yearButtons(grade, subject, medium) {
  const cy = new Date().getFullYear();
  const sl = subject.toLowerCase();
  const ml = medium.toLowerCase();
  return [
    { label:`📅 ${cy-1}`, id:`.passpaper ${grade} ${sl} ${ml} ${cy-1}` },
    { label:`📅 ${cy-2}`, id:`.passpaper ${grade} ${sl} ${ml} ${cy-2}` },
    { label:`📅 ${cy-3}`, id:`.passpaper ${grade} ${sl} ${ml} ${cy-3}` },
    { label:`📅 ${cy-4}`, id:`.passpaper ${grade} ${sl} ${ml} ${cy-4}` },
  ];
}

// ── HTTP ──────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
async function httpGet(url, timeout=12000) {
  const res = await axios.get(url,{timeout,headers:{'User-Agent':UA}});
  return res.data||'';
}
function extractPDFs(html, year) {
  const all=[...html.matchAll(/https?:\/\/[^\s"'<>]+\.pdf/gi)].map(m=>m[0]);
  const yr=year?all.filter(u=>u.includes(String(year))):[];
  return yr.length?yr:all;
}

// ── Sources ───────────────────────────────────────────────────
async function srcPastpapersWiki(grade,subject,medium,year) {
  const gs=grade==='ol'?'ol':grade==='al'?'al':`grade-${grade}`;
  const ss=subject.toLowerCase().replace(/\s+/g,'-');
  for (const url of [
    `https://pastpapers.wiki/${gs}-${ss}-${medium.toLowerCase()}-medium-past-papers/`,
    `https://pastpapers.wiki/${gs}-${ss}-past-papers/`,
    `https://pastpapers.wiki/${ss}-${gs}-past-papers/`,
  ]) {
    try {
      const html=await httpGet(url);
      const pdfs=extractPDFs(html,year);
      if (pdfs.length) return {type:'pdf',url:pdfs[0],source:'pastpapers.wiki'};
      if (html.length>5000) return {type:'link',url,source:'pastpapers.wiki'};
    } catch(e) { if(e?.response?.status!==404) continue; }
  }
  return null;
}
async function srcStudentLanka(grade,subject,medium,year) {
  const gs=grade==='ol'?'o-l':grade==='al'?'a-l':`grade-${grade}`;
  const ss=subject.toLowerCase().replace(/\s+/g,'-');
  for (const url of [
    `https://www.studentlanka.com/past-papers/${gs}-${ss}-past-papers/`,
    `https://www.studentlanka.com/past-papers/`,
  ]) {
    try {
      const html=await httpGet(url);
      const pdfs=extractPDFs(html,year);
      if (pdfs.length) return {type:'pdf',url:pdfs[0],source:'studentlanka.com'};
    } catch {}
  }
  return null;
}
async function srcGradeLk(grade,subject,_medium,year) {
  const gn=grade==='ol'?11:grade==='al'?13:parseInt(grade,10);
  const ss=subject.toLowerCase().replace(/\s+/g,'-');
  for (const url of [
    `https://www.grade.lk/grade-${gn}-${ss}-past-papers/`,
    `https://www.grade.lk/${ss}-past-papers-grade-${gn}/`,
  ]) {
    try {
      const html=await httpGet(url);
      const pdfs=extractPDFs(html,year);
      if (pdfs.length) return {type:'pdf',url:pdfs[0],source:'grade.lk'};
    } catch {}
  }
  return null;
}
async function srcEthaksalawa(grade,subject,medium,year) {
  const gn=grade==='ol'?11:grade==='al'?13:parseInt(grade,10);
  const mc=medium==='Sinhala'?'S':medium==='Tamil'?'T':'E';
  const url=`https://e-thaksalawa.moe.gov.lk/web/guest/resource-en?p_p_id=resourcesportlet_WAR_ETPortlet`+
    `&_resourcesportlet_WAR_ETPortlet_grade=${gn}`+
    `&_resourcesportlet_WAR_ETPortlet_subject=${encodeURIComponent(subject)}`+
    `&_resourcesportlet_WAR_ETPortlet_medium=${mc}`+
    `&_resourcesportlet_WAR_ETPortlet_year=${year}`+
    `&_resourcesportlet_WAR_ETPortlet_type=PP`;
  try {
    const html=await httpGet(url);
    const pdfs=extractPDFs(html,year);
    if (pdfs.length) return {type:'pdf',url:pdfs[0],source:'e-thaksalawa.moe.gov.lk'};
  } catch {}
  return null;
}
async function srcDuckDuckGo(grade,subject,medium,year) {
  const gl=grade==='ol'?'OL grade 11':grade==='al'?'AL grade 13':`grade ${grade}`;
  const q=`${gl} ${subject} ${medium} medium past paper ${year} Sri Lanka filetype:pdf`;
  try {
    const html=await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
    const pdfs=extractPDFs(html,year);
    if (pdfs.length) return {type:'pdf',url:pdfs[0],source:'DuckDuckGo'};
    const sites=[...html.matchAll(/https?:\/\/(?:pastpapers?\.wiki|studentlanka\.com|grade\.lk|doenets\.lk)[^\s"'<>]*/gi)].map(m=>m[0]);
    if (sites.length) return {type:'link',url:sites[0],source:'DuckDuckGo'};
  } catch {}
  const ddg=`${gl} ${subject} ${medium} medium past paper ${year} Sri Lanka`;
  return {type:'search',url:`https://duckduckgo.com/?q=${encodeURIComponent(ddg)}`,source:'DuckDuckGo'};
}

async function findPaper(grade,subject,medium,year) {
  for (const fn of [
    ()=>srcPastpapersWiki(grade,subject,medium,year),
    ()=>srcStudentLanka(grade,subject,medium,year),
    ()=>srcGradeLk(grade,subject,medium,year),
    ()=>srcEthaksalawa(grade,subject,medium,year),
    ()=>srcDuckDuckGo(grade,subject,medium,year),
  ]) {
    try { const r=await fn(); if(r) return r; } catch {}
  }
  return null;
}

async function downloadPDF(url) {
  const res=await axios.get(url,{
    responseType:'arraybuffer',timeout:30000,
    maxContentLength:50*1024*1024,
    headers:{'User-Agent':UA},
  });
  const ct=(res.headers['content-type']||'').toLowerCase();
  if(!ct.includes('pdf')&&!ct.includes('octet')) throw new Error('Not a PDF');
  return Buffer.from(res.data);
}

async function sendPaper(sock,m,grade,subject,medium,year) {
  const gl=gradeLabel(grade);
  const sl=subject.toLowerCase(), ml=medium.toLowerCase();
  await m.reply(`⏳ *${gl} ${subject}* (${medium}) *${year}* සොයනවා...\n_Checking 5 sources..._`);

  const result=await findPaper(grade,subject,medium,year);

  if (!result) {
    return sendButtons(sock,m.chat,{
      text:`❌ *${gl} ${subject} (${medium}) ${year}* not found.\n\n💡 Try a different year.\n\n${cfg.footer}`,
      footer:cfg.footer,
      buttons:[
        {label:`📅 ${year-1}`,id:`.passpaper ${grade} ${sl} ${ml} ${year-1}`},
        {label:`📅 ${year-2}`,id:`.passpaper ${grade} ${sl} ${ml} ${year-2}`},
        {label:`🔄 Other subject`,id:`.passpaper ${grade}`},
      ],
    });
  }

  if (result.type==='pdf') {
    try {
      await m.reply(`📥 Found on *${result.source}*! Downloading...`);
      const buf=await downloadPDF(result.url);
      const fname=`${grade}_${sl}_${ml}_${year}.pdf`.replace(/[\s/]+/g,'_');
      await sock.sendMessage(m.chat,{
        document:buf,mimetype:'application/pdf',fileName:fname,
        caption:
          `📄 *${gl} — ${subject}*\n`+
          `🌐 Medium : *${medium}*\n`+
          `📅 Year   : *${year}*\n`+
          `📦 Size   : ${(buf.length/1024).toFixed(1)} KB\n`+
          `🔗 Source : ${result.source}\n\n${cfg.footer}`,
      },{quoted:m.msg});
      return sendButtons(sock,m.chat,{
        text:`✅ *Paper sent!*  📄 ${gl} ${subject} — ${medium} ${year}\n\n${cfg.footer}`,
        footer:cfg.footer,
        buttons:[
          {label:`📅 ${year-1}`,id:`.passpaper ${grade} ${sl} ${ml} ${year-1}`},
          {label:`📅 ${year-2}`,id:`.passpaper ${grade} ${sl} ${ml} ${year-2}`},
          {label:`📚 Other subject`,id:`.passpaper ${grade}`},
        ],
      });
    } catch { result.type='link'; }
  }

  await sendButtons(sock,m.chat,{
    text:
      `🔗 *${gl} ${subject} — ${medium} ${year}*\n\n`+
      `Found on *${result.source}*:\n\n`+
      `📎 ${result.url}\n\n`+
      `_Open link to download manually_\n\n${cfg.footer}`,
    footer:cfg.footer,
    buttons:[
      {label:`🔄 Try again`,   id:`.passpaper ${grade} ${sl} ${ml} ${year}`},
      {label:`📅 ${year-1}`,   id:`.passpaper ${grade} ${sl} ${ml} ${year-1}`},
    ],
  });
}

// ── handlePendingPP: only called for TYPED text (isCmd=false) ─
async function handlePendingPP(sock,m) {
  const session=ppSessions.get(m.chat);
  if (!session) return false;

  const body=(m.body||'').trim();

  if (session.step==='subject') {
    const sub=normalizeSubject(body);
    if (!sub) {
      await m.reply(`❌ Unknown subject.\n\nAvailable: ${(GRADE_SUBJECTS[session.grade]||[]).join(', ')}`);
      return true;
    }
    ppSessions.delete(m.chat);
    // Show medium buttons (self-contained IDs, no more session needed)
    await sendButtons(sock,m.chat,{
      text:`✅ Subject: *${sub}*\n\n🌐 *Select Medium / භාෂා / மொழி*\n\n${cfg.footer}`,
      footer:cfg.footer,
      buttons:mediumButtons(session.grade,sub),
    });
    return true;
  }

  if (session.step==='medium') {
    // Accept number shortcuts: 1=Sinhala, 2=English, 3=Tamil
    const numToMedium = {'1':'Sinhala','2':'English','3':'Tamil'};
    const medium = numToMedium[body] || normalizeMedium(body);
    if (!medium) { await m.reply(`❌ Type: *sinhala*, *english*, *tamil*\nor reply *1* / *2* / *3*`); return true; }
    ppSessions.delete(m.chat);
    await sendButtons(sock,m.chat,{
      text:`✅ Medium: *${medium}*\n\n📅 *Select year or type it:*\n\n${cfg.footer}`,
      footer:cfg.footer,
      buttons:yearButtons(session.grade,session.subject,medium),
    });
    return true;
  }

  if (session.step==='year') {
    const year=validateYear(body);
    if (!year) { await m.reply(`❌ Invalid year. Enter between 2000–${new Date().getFullYear()}`); return true; }
    ppSessions.delete(m.chat);
    await sendPaper(sock,m,session.grade,session.subject,session.medium,year);
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
module.exports = {
  commands: ['passpaper','pp','pastpaper','passparer'],
  handlePendingPP,

  async run({ sock, m }) {
    const args    = (m.text||'').trim().split(/\s+/).filter(Boolean);
    const grade   = normalizeGrade(args[0]);
    const subject = normalizeSubject(args[1]);
    const medium  = normalizeMedium(args[2]);
    const year    = validateYear(args[3]);

    // ── No grade ──────────────────────────────────────────
    if (!grade) {
      return sendButtons(sock,m.chat,{
        text:
          `📚 *PAST PAPER DOWNLOADER*\n`+
          `━━━━━━━━━━━━━━━━━━━━━━━\n\n`+
          `Usage: *.pp [grade] [subject] [medium] [year]*\n\n`+
          `Examples:\n`+
          `  *.pp grade8 maths sinhala 2023*\n`+
          `  *.pp ol science english 2022*\n`+
          `  *.pp al physics sinhala*\n\n${cfg.footer}`,
        footer:cfg.footer,
        buttons:[
          {label:'📗 Grade 8',id:'.passpaper grade8'},
          {label:'📘 Grade 9',id:'.passpaper grade9'},
          {label:'📙 O/L',    id:'.passpaper ol'},
          {label:'📕 A/L',    id:'.passpaper al'},
        ],
      });
    }

    // ── All 4 → download ─────────────────────────────────
    if (subject && medium && year) {
      return sendPaper(sock,m,grade,subject,medium,year);
    }

    // ── Subject missing → subject buttons + session for typing
    if (!subject) {
      const subs=GRADE_SUBJECTS[grade]||[];
      ppSessions.set(m.chat,{grade,step:'subject'});
      return sendButtons(sock,m.chat,{
        text:
          `📚 *${gradeLabel(grade)} Past Paper*\n`+
          `━━━━━━━━━━━━━━━━━━━━━━━\n\n`+
          `Select subject or type name:\n\n`+
          `Available: ${subs.join(' · ')}\n\n${cfg.footer}`,
        footer:cfg.footer,
        buttons:subjectButtons(grade,subs),
      });
    }

    // ── Medium missing → medium buttons + session for typing
    if (!medium) {
      ppSessions.set(m.chat,{grade,subject,step:'medium'});
      return sendButtons(sock,m.chat,{
        text:`📚 *${gradeLabel(grade)} — ${subject}*\n\n🌐 *Select Medium / භාෂා / மொழி*\n\n${cfg.footer}`,
        footer:cfg.footer,
        buttons:mediumButtons(grade,subject),
      });
    }

    // ── Year missing → year buttons + session for typing
    ppSessions.set(m.chat,{grade,subject,medium,step:'year'});
    return sendButtons(sock,m.chat,{
      text:`📚 *${gradeLabel(grade)} — ${subject} (${medium})*\n\n📅 *Select year or type it:*\n\n${cfg.footer}`,
      footer:cfg.footer,
      buttons:yearButtons(grade,subject,medium),
    });
  },
};
