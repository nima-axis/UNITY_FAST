'use strict';
const cfg = require('../../config');

// ── Country code database (top 60 codes) ─────────────────────
const COUNTRY_CODES = {
  '1':'🇺🇸 United States / Canada','7':'🇷🇺 Russia / Kazakhstan',
  '20':'🇪🇬 Egypt','27':'🇿🇦 South Africa','30':'🇬🇷 Greece',
  '31':'🇳🇱 Netherlands','32':'🇧🇪 Belgium','33':'🇫🇷 France',
  '34':'🇪🇸 Spain','36':'🇭🇺 Hungary','39':'🇮🇹 Italy',
  '40':'🇷🇴 Romania','41':'🇨🇭 Switzerland','43':'🇦🇹 Austria',
  '44':'🇬🇧 United Kingdom','45':'🇩🇰 Denmark','46':'🇸🇪 Sweden',
  '47':'🇳🇴 Norway','48':'🇵🇱 Poland','49':'🇩🇪 Germany',
  '51':'🇵🇪 Peru','52':'🇲🇽 Mexico','53':'🇨🇺 Cuba',
  '54':'🇦🇷 Argentina','55':'🇧🇷 Brazil','56':'🇨🇱 Chile',
  '57':'🇨🇴 Colombia','58':'🇻🇪 Venezuela','60':'🇲🇾 Malaysia',
  '61':'🇦🇺 Australia','62':'🇮🇩 Indonesia','63':'🇵🇭 Philippines',
  '64':'🇳🇿 New Zealand','65':'🇸🇬 Singapore','66':'🇹🇭 Thailand',
  '77':'🇰🇿 Kazakhstan','81':'🇯🇵 Japan','82':'🇰🇷 South Korea',
  '84':'🇻🇳 Vietnam','86':'🇨🇳 China','90':'🇹🇷 Turkey',
  '91':'🇮🇳 India','92':'🇵🇰 Pakistan','93':'🇦🇫 Afghanistan',
  '94':'🇱🇰 Sri Lanka','95':'🇲🇲 Myanmar','98':'🇮🇷 Iran',
  '212':'🇲🇦 Morocco','213':'🇩🇿 Algeria','216':'🇹🇳 Tunisia',
  '218':'🇱🇾 Libya','220':'🇬🇲 Gambia','221':'🇸🇳 Senegal',
  '233':'🇬🇭 Ghana','234':'🇳🇬 Nigeria','254':'🇰🇪 Kenya',
  '256':'🇺🇬 Uganda','260':'🇿🇲 Zambia','263':'🇿🇼 Zimbabwe',
  '966':'🇸🇦 Saudi Arabia','967':'🇾🇪 Yemen','971':'🇦🇪 UAE',
  '972':'🇮🇱 Israel','974':'🇶🇦 Qatar','880':'🇧🇩 Bangladesh',
};

function getCountry(number) {
  const n = number.replace(/\D/g, '');
  for (const len of [3, 2, 1]) {
    const prefix = n.slice(0, len);
    if (COUNTRY_CODES[prefix]) return COUNTRY_CODES[prefix];
  }
  return '🌍 Unknown';
}

// ── Device detection from message ID prefix ───────────────────
function detectDevice(msgId = '') {
  const id = msgId.toUpperCase();
  if (id.startsWith('3EB0'))  return 'Android 📱';
  if (id.startsWith('3A'))    return 'iOS — iPhone 🍎';
  if (id.startsWith('BAE5'))  return 'WhatsApp Web 🌐';
  if (id.startsWith('BAEBB')) return 'WhatsApp Desktop 🖥️';
  if (id.startsWith('BAE'))   return 'WhatsApp Business App 💼';
  if (id.startsWith('3EB5'))  return 'KaiOS Feature Phone 📟';
  if (id.startsWith('3EB1'))  return 'Android (Tablet) 📲';
  return 'Unknown Device ❓';
}

// ── Message type → human label ────────────────────────────────
function humanType(type = '') {
  const map = {
    conversation:        'Text 💬',
    extendedTextMessage: 'Text with Link/Quote 💬',
    imageMessage:        'Image 🖼️',
    videoMessage:        'Video 🎥',
    audioMessage:        'Audio / Voice 🎵',
    documentMessage:     'Document 📄',
    stickerMessage:      'Sticker 🎭',
    contactMessage:      'Contact Card 👤',
    locationMessage:     'Location 📍',
    liveLocationMessage: 'Live Location 📡',
    pollCreationMessage: 'Poll 📊',
    reactionMessage:     'Reaction 👍',
    viewOnceMessage:     'View Once 👁️',
    viewOnceMessageV2:   'View Once 👁️',
    protocolMessage:     'Deleted Message 🗑️',
  };
  return map[type] || type || 'Unknown';
}

// ── Format timestamp ──────────────────────────────────────────
function fmtTime(ts) {
  if (!ts) return 'Unknown';
  return new Date(Number(ts) * 1000).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
}

// ── Time ago ──────────────────────────────────────────────────
function timeAgo(ts) {
  if (!ts) return '';
  const sec = Math.floor(Date.now() / 1000 - Number(ts));
  if (sec < 60)   return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400)return `${Math.floor(sec/3600)}h ago`;
  return `${Math.floor(sec/86400)}d ago`;
}

module.exports = {
  commands: ['hack', 'whois', 'scan'],
  ownerOnly: true,

  async run({ sock, m }) {
    // ── Resolve target ─────────────────────────────────────────
    // Priority: @mention > reply > text number > self
    let targetJid    = null;
    let targetMsgId  = null;
    let targetMsgType= null;
    let targetMsgTs  = null;
    let targetName   = null;

    // 1. @mention (highest priority)
    const mentionCtx =
      m.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
      m.message?.imageMessage?.contextInfo?.mentionedJid ||
      m.message?.videoMessage?.contextInfo?.mentionedJid || [];

    if (mentionCtx.length > 0) {
      targetJid = mentionCtx[0];
    }
    // 2. Quoted message
    else if (m.quoted?.sender) {
      targetJid     = m.quoted.sender;
      targetName    = m.quoted.pushName || null;
      targetMsgId   = m.quoted.key?.id || null;
      targetMsgType = m.quoted.type || Object.keys(m.quoted.message || {})[0] || null;
    }
    // 3. Number in text
    else if (m.text?.trim()) {
      const num = m.text.trim().replace(/\D/g, '');
      if (num.length >= 7) targetJid = num + '@s.whatsapp.net';
    }
    // 4. Self
    else {
      targetJid     = m.sender;
      targetName    = m.pushName;
      targetMsgId   = m.key?.id;
      targetMsgType = m.msgType;
      targetMsgTs   = m.msg?.messageTimestamp;
    }

    if (!targetJid) return m.reply(`📌 *Usage:*\n*.hack* @user\n*.hack* [reply to message]\n*.hack* 947xxxxxxxx\n\n${cfg.footer}`);

    await m.react('🔍');
    await sock.sendMessage(m.chat, {
      text: `🖥️ _Scanning target... please wait_`,
      _noImage: true,
    }, { quoted: m.msg });

    const number = targetJid.replace('@s.whatsapp.net','').replace('@lid','').replace(/\D/g,'');

    // ── Parallel data fetch ───────────────────────────────────
    const [waInfo, statusInfo, ppUrl, bizProfile, allGroups] = await Promise.all([
      sock.onWhatsApp(targetJid).catch(() => [null]),
      sock.fetchStatus(targetJid).catch(() => null),
      sock.profilePictureUrl(targetJid, 'image').catch(() => null),
      sock.getBusinessProfile(targetJid).catch(() => null),
      sock.groupFetchAllParticipating().catch(() => ({})),
    ]);

    const waResult   = Array.isArray(waInfo) ? waInfo[0] : null;
    const onWA       = waResult?.exists ?? null;
    const isBusiness = !!waResult?.isBusiness || !!bizProfile;

    // ── Common groups analysis ────────────────────────────────
    const commonGroups = [];
    for (const [gid, gmeta] of Object.entries(allGroups || {})) {
      const inGroup = (gmeta.participants || []).some(p => p.id === targetJid);
      if (inGroup) commonGroups.push(gmeta.subject || gid);
    }

    // ── Status info ───────────────────────────────────────────
    const aboutText  = statusInfo?.status || null;
    const aboutSetAt = statusInfo?.setAt  || null;

    // ── Device from msg ID ────────────────────────────────────
    const msgIdRaw  = targetMsgId || m.msg?.key?.id || '';
    const device    = detectDevice(msgIdRaw);
    const msgIdFmt  = msgIdRaw ? `${msgIdRaw.slice(0,6)}...${msgIdRaw.slice(-4)}` : 'N/A';

    // ── Last media type ───────────────────────────────────────
    const lastMsgLabel = targetMsgType ? humanType(targetMsgType) : 'N/A';
    const lastMsgTime  = targetMsgTs   ? fmtTime(targetMsgTs)     : 'N/A';
    const lastMsgAgo   = targetMsgTs   ? `(${timeAgo(targetMsgTs)})` : '';

    // ── Business profile extras ───────────────────────────────
    let bizLines = '';
    if (bizProfile) {
      bizLines =
        `\n🏢 *Business Info*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        (bizProfile.description ? `📋 *Desc:* ${bizProfile.description.slice(0,80)}\n` : '') +
        (bizProfile.email       ? `📧 *Email:* ${bizProfile.email}\n`                   : '') +
        (bizProfile.website?.[0]? `🌐 *Website:* ${bizProfile.website[0]}\n`            : '') +
        (bizProfile.category    ? `🏷️ *Category:* ${bizProfile.category}\n`             : '');
    }

    // ── Build report ──────────────────────────────────────────
    const border = '━━━━━━━━━━━━━━━━━━━━━━━━━';

    const report =
      `╔══════════════════════════╗\n` +
      `   🔓 *H A C K  R E P O R T*\n` +
      `╚══════════════════════════╝\n\n` +

      `🎯 *Target Identified*\n${border}\n` +
      `📛 *Name:* ${targetName || m.pushName || '[ Hidden ]'}\n` +
      `📞 *Number:* +${number}\n` +
      `🌍 *Country:* ${getCountry(number)}\n` +
      `🆔 *JID:* \`${targetJid}\`\n` +
      `✅ *On WhatsApp:* ${onWA === true ? 'Yes ✅' : onWA === false ? 'No ❌' : 'Unknown'}\n` +
      `💼 *Account Type:* ${isBusiness ? 'Business 🏢' : 'Personal 👤'}\n\n` +

      `📱 *Device & Platform*\n${border}\n` +
      `🖥️ *Device:* ${device}\n` +
      `🔑 *Msg ID:* \`${msgIdFmt}\`\n\n` +

      `💬 *Last Activity*\n${border}\n` +
      `📨 *Last Msg Type:* ${lastMsgLabel}\n` +
      `⏰ *Sent At:* ${lastMsgTime} ${lastMsgAgo}\n\n` +

      `📝 *Profile Data*\n${border}\n` +
      `💭 *About:* ${aboutText || '[ No status set ]'}\n` +
      (aboutSetAt ? `🕐 *About Set:* ${fmtTime(aboutSetAt)} ${timeAgo(aboutSetAt) ? `(${timeAgo(aboutSetAt)})` : ''}\n` : '') +
      `🖼️ *Profile Pic:* ${ppUrl ? 'Available ✅' : 'Hidden / None ❌'}\n\n` +

      `👥 *Mutual Groups (${commonGroups.length})*\n${border}\n` +
      (commonGroups.length > 0
        ? commonGroups.slice(0, 8).map((g, i) => `${i+1}. ${g}`).join('\n') +
          (commonGroups.length > 8 ? `\n... +${commonGroups.length - 8} more` : '')
        : '[ No common groups ]') +
      `\n` +
      bizLines +
      `\n${cfg.footer}`;

    await m.react('✅');

    if (ppUrl) {
      try {
        return await sock.sendMessage(m.chat, {
          image: { url: ppUrl },
          caption: report,
          _noImage: true,
        }, { quoted: m.msg });
      } catch {}
    }

    return m.reply(report);
  },
};
