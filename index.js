/**
 * 👑 CrownX Helper — single-file build
 * Everything (config, models, embeds, commands, buttons, modals,
 * $ prefix commands, QR generator, admin panel) lives in this one
 * file on purpose, so deployment is just: package.json + index.js.
 *
 * Run:
 *   node index.js --deploy   → registers/updates slash commands
 *   node index.js            → starts the bot
 */

require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  MessageFlags,
  ActivityType,
} = require('discord.js');

// ============================================================
// CONFIG
// ============================================================

const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID || null,
  mongoUri: process.env.MONGODB_URI,
  adminRoleIds: (process.env.ADMIN_ROLE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  logoUrl: process.env.BRAND_LOGO_URL || null,
  prefix: '$',
  brand: {
    tagline: '👑 Premium Crypto Exchange',
    footer: 'CrownX Exchange • Trusted & Secure',
  },
  colors: {
    gold: 0xd4af37,
    success: 0x2ecc71,
    pending: 0xf1c40f,
    cancelled: 0xe74c3c,
    error: 0xe74c3c,
  },
  emojis: { crown: '👑', coin: '💱' },
  defaults: {
    rates: { C2I: 101, I2C: 104 },
    limits: { I2C: { min: 104, max: 100000 }, C2I: { min: 1, max: 1000 } },
    fees: { I2C: 0, C2I: 0 },
    exchangeEnabled: { I2C: true, C2I: true },
  },
  cooldownSeconds: 5,
};

if (!config.token) {
  console.error('❌ Missing DISCORD_TOKEN in your .env / Railway variables.');
  process.exit(1);
}

// ============================================================
// DATABASE MODELS
// ============================================================

const { Schema, model } = mongoose;

const User = model(
  'User',
  new Schema({
    discordId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    joinDate: { type: Date, default: Date.now },
  }),
);

const Transaction = model(
  'Transaction',
  new Schema({
    transactionId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    username: { type: String, required: true },
    type: { type: String, enum: ['I2C', 'C2I'], required: true },
    inputAmount: { type: Number, required: true },
    outputAmount: { type: Number, required: true },
    rate: { type: Number, required: true },
    fee: { type: Number, default: 0 },
    status: { type: String, enum: ['Pending', 'Completed', 'Cancelled'], default: 'Pending' },
    processedBy: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  }).pre('save', function (next) {
    this.updatedAt = new Date();
    next();
  }),
);

const Settings = model(
  'Settings',
  new Schema({
    key: { type: String, default: 'global', unique: true },
    rates: {
      C2I: { type: Number, default: config.defaults.rates.C2I },
      I2C: { type: Number, default: config.defaults.rates.I2C },
    },
    limits: {
      I2C: { min: { type: Number, default: config.defaults.limits.I2C.min }, max: { type: Number, default: config.defaults.limits.I2C.max } },
      C2I: { min: { type: Number, default: config.defaults.limits.C2I.min }, max: { type: Number, default: config.defaults.limits.C2I.max } },
    },
    fees: {
      I2C: { type: Number, default: config.defaults.fees.I2C },
      C2I: { type: Number, default: config.defaults.fees.C2I },
    },
    exchangeEnabled: {
      I2C: { type: Boolean, default: config.defaults.exchangeEnabled.I2C },
      C2I: { type: Boolean, default: config.defaults.exchangeEnabled.C2I },
    },
  }),
);

const AuditLog = model(
  'AuditLog',
  new Schema({
    action: { type: String, required: true },
    oldValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
    adminId: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  }),
);

async function getSettings() {
  let s = await Settings.findOne({ key: 'global' });
  if (!s) s = await Settings.create({ key: 'global' });
  return s;
}

// ============================================================
// UTILITIES
// ============================================================

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function calculate(type, amount, rates, fees = { I2C: 0, C2I: 0 }) {
  if (type === 'I2C') {
    const rate = rates.I2C;
    const raw = round2(amount / rate);
    const fee = fees.I2C || 0;
    const output = fee ? round2(raw - raw * (fee / 100)) : raw;
    return { type, input: amount, output, rate, fee };
  }
  if (type === 'C2I') {
    const rate = rates.C2I;
    const raw = round2(amount * rate);
    const fee = fees.C2I || 0;
    const output = fee ? round2(raw - raw * (fee / 100)) : raw;
    return { type, input: round2(amount), output, rate, fee };
  }
  throw new Error(`Unknown exchange type: ${type}`);
}

function generateTransactionId() {
  return `CX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function formatINR(amount) {
  return `₹${Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
function formatCrypto(amount) {
  return `${Number(amount).toFixed(2)} C`;
}
function formatDate(date) {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:f>`;
}
function statusEmoji(status) {
  return { Completed: '✅', Pending: '🕓', Cancelled: '❌' }[status] || '';
}
function typeLabel(type) {
  return type === 'I2C' ? 'INR → Crypto' : 'Crypto → INR';
}
function formatAmount(type, side, amount) {
  const isInrSide = (type === 'I2C' && side === 'input') || (type === 'C2I' && side === 'output');
  return isInrSide ? formatINR(amount) : formatCrypto(amount);
}

function isAdmin(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (!config.adminRoleIds.length) return false;
  return member.roles?.cache?.some((r) => config.adminRoleIds.includes(r.id));
}

const cooldowns = new Map();
function checkCooldown(userId, cmd, seconds = config.cooldownSeconds) {
  const key = `${userId}:${cmd}`;
  const now = Date.now();
  const expiry = cooldowns.get(key);
  if (expiry && expiry > now) return Math.ceil((expiry - now) / 1000);
  cooldowns.set(key, now + seconds * 1000);
  return 0;
}

async function generateQrBuffer(text) {
  return QRCode.toBuffer(text, {
    type: 'png',
    width: 512,
    margin: 2,
    color: { dark: '#D4AF37', light: '#000000' },
    errorCorrectionLevel: 'H',
  });
}

async function ensureUser(discordUser) {
  await User.findOneAndUpdate(
    { discordId: discordUser.id },
    { $setOnInsert: { discordId: discordUser.id, username: discordUser.username, joinDate: new Date() } },
    { upsert: true },
  );
}

function validateLimit(type, amount, settings) {
  const { min, max } = settings.limits[type];
  if (amount < min) return `Amount is below the minimum of ${min}.`;
  if (amount > max) return `Amount exceeds the maximum of ${max}.`;
  return null;
}

async function quote(type, amount) {
  const settings = await getSettings();
  if (!settings.exchangeEnabled[type]) return { error: `${type} exchanges are currently disabled.` };
  const limitError = validateLimit(type, amount, settings);
  if (limitError) return { error: limitError };
  return { result: calculate(type, amount, settings.rates, settings.fees), settings };
}

async function createTransaction(discordUser, type, amount) {
  const { error, result } = await quote(type, amount);
  if (error) return { error };
  await ensureUser(discordUser);
  const tx = await Transaction.create({
    transactionId: generateTransactionId(),
    userId: discordUser.id,
    username: discordUser.username,
    type: result.type,
    inputAmount: result.input,
    outputAmount: result.output,
    rate: result.rate,
    fee: result.fee,
    status: 'Pending',
  });
  return { transaction: tx };
}

// ============================================================
// EMBEDS
// ============================================================

function baseEmbed({ color = config.colors.gold, author = true } = {}) {
  const embed = new EmbedBuilder().setColor(color).setFooter({ text: config.brand.footer }).setTimestamp();
  if (author) embed.setAuthor({ name: config.brand.tagline });
  if (config.logoUrl) embed.setThumbnail(config.logoUrl);
  return embed;
}

function statusColor(status) {
  return { Completed: config.colors.success, Pending: config.colors.pending, Cancelled: config.colors.cancelled }[status] || config.colors.gold;
}

function confirmationEmbed({ type, input, output, rate, fee }) {
  return baseEmbed()
    .setTitle(`${config.emojis.coin} Confirm Exchange — ${typeLabel(type)}`)
    .setDescription('Review the details below, then confirm to create your exchange request.')
    .addFields(
      { name: 'You Send', value: formatAmount(type, 'input', input), inline: true },
      { name: 'You Receive', value: formatAmount(type, 'output', output), inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Rate', value: type === 'I2C' ? `₹${rate} = 1 C` : `1 C = ₹${rate}`, inline: true },
      { name: 'Fee', value: fee ? `${fee}%` : '0%', inline: true },
    );
}

function transactionCreatedEmbed(tx) {
  return baseEmbed({ color: statusColor(tx.status) })
    .setTitle('✅ Exchange Request Created')
    .addFields(
      { name: 'Transaction ID', value: `\`${tx.transactionId}\``, inline: true },
      { name: 'Type', value: typeLabel(tx.type), inline: true },
      { name: 'Status', value: `${statusEmoji(tx.status)} ${tx.status}`, inline: true },
      { name: 'Input', value: formatAmount(tx.type, 'input', tx.inputAmount), inline: true },
      { name: 'Output', value: formatAmount(tx.type, 'output', tx.outputAmount), inline: true },
      { name: 'Rate', value: `${tx.rate}`, inline: true },
      { name: 'Fee', value: tx.fee ? `${tx.fee}%` : '0%', inline: true },
    );
}

function transactionDetailEmbed(tx, { showProcessor = false } = {}) {
  const embed = baseEmbed({ color: statusColor(tx.status) })
    .setTitle(`${config.emojis.coin} Transaction Details`)
    .addFields(
      { name: 'Transaction ID', value: `\`${tx.transactionId}\``, inline: true },
      { name: 'User', value: `<@${tx.userId}>`, inline: true },
      { name: 'Type', value: typeLabel(tx.type), inline: true },
      { name: 'Input', value: formatAmount(tx.type, 'input', tx.inputAmount), inline: true },
      { name: 'Output', value: formatAmount(tx.type, 'output', tx.outputAmount), inline: true },
      { name: 'Rate', value: `${tx.rate}`, inline: true },
      { name: 'Fee', value: tx.fee ? `${tx.fee}%` : '0%', inline: true },
      { name: 'Status', value: `${statusEmoji(tx.status)} ${tx.status}`, inline: true },
      { name: 'Date', value: formatDate(tx.createdAt), inline: true },
    );
  if (showProcessor) {
    embed.addFields({ name: 'Staff Processor', value: tx.processedBy ? `<@${tx.processedBy}>` : 'Not yet processed' });
  }
  return embed;
}

function calculatorEmbed({ type, input, output, rate }) {
  return baseEmbed()
    .setTitle(`🧮 Calculator — ${typeLabel(type)}`)
    .addFields(
      { name: 'Amount Given', value: formatAmount(type, 'input', input), inline: true },
      { name: 'Rate', value: type === 'I2C' ? `₹${rate} = 1 C` : `1 C = ₹${rate}`, inline: true },
      { name: 'Amount Received', value: formatAmount(type, 'output', output), inline: true },
    )
    .setDescription('⚠️ This is a calculation only — no exchange has been created.');
}

function historyCardEmbed(tx) {
  return baseEmbed({ color: statusColor(tx.status) }).addFields({
    name: `${tx.transactionId} • ${typeLabel(tx.type)}`,
    value:
      `**Input:** ${formatAmount(tx.type, 'input', tx.inputAmount)}\n` +
      `**Output:** ${formatAmount(tx.type, 'output', tx.outputAmount)}\n` +
      `**Status:** ${statusEmoji(tx.status)} ${tx.status}\n` +
      `**Date:** ${formatDate(tx.createdAt)}`,
  });
}

function rateEmbed(s) {
  return baseEmbed()
    .setTitle('💹 Live Exchange Rates')
    .addFields(
      { name: 'C2I (Crypto → INR)', value: `1 C = ₹${s.rates.C2I}`, inline: true },
      { name: 'I2C (INR → Crypto)', value: `₹${s.rates.I2C} = 1 C`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Supported Exchanges', value: '• C2I — Crypto → INR\n• I2C — INR → Crypto' },
    );
}

function statusEmbed(s) {
  const line = (e) => (e ? '🟢 Available' : '🔴 Disabled');
  return baseEmbed()
    .setTitle('📡 System Status')
    .addFields(
      { name: 'I2C', value: line(s.exchangeEnabled.I2C), inline: true },
      { name: 'C2I', value: line(s.exchangeEnabled.C2I), inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Current Rates', value: `I2C: ₹${s.rates.I2C} = 1 C\nC2I: 1 C = ₹${s.rates.C2I}` },
      { name: 'System', value: s.exchangeEnabled.I2C || s.exchangeEnabled.C2I ? '🟢 Operational' : '🔴 Under Maintenance' },
    );
}

function limitsEmbed(s) {
  return baseEmbed()
    .setTitle('📏 Exchange Limits')
    .addFields(
      { name: 'I2C (INR → Crypto)', value: `Minimum: ${formatINR(s.limits.I2C.min)}\nMaximum: ${formatINR(s.limits.I2C.max)}`, inline: true },
      { name: 'C2I (Crypto → INR)', value: `Minimum: ${formatCrypto(s.limits.C2I.min)}\nMaximum: ${formatCrypto(s.limits.C2I.max)}`, inline: true },
    );
}

function feesEmbed(s) {
  return baseEmbed()
    .setTitle('💸 Exchange Fees')
    .addFields({ name: 'I2C Fee', value: `${s.fees.I2C}%`, inline: true }, { name: 'C2I Fee', value: `${s.fees.C2I}%`, inline: true });
}

function helpEmbed() {
  return baseEmbed()
    .setTitle(`${config.emojis.crown} CrownX Helper`)
    .setDescription('**Your trusted gateway between INR and Crypto.**\nUse the commands below to exchange, calculate, and track your transactions.')
    .addFields(
      { name: '💱 Exchange', value: '`/i2c` `/c2i` `/exchange`' },
      { name: '🧮 Calculator', value: '`/calculator` `/rate`' },
      { name: '📱 QR Code', value: '`/qr` — generate a QR for any text, link, or wallet address' },
      { name: '📜 Transactions', value: '`/history` `/transaction` `/my-exchanges`' },
      { name: 'ℹ️ Information', value: '`/status` `/limits` `/fees` `/help`' },
      { name: '⌨️ Quick Prefix', value: `Every command above also works with \`${config.prefix}\`, e.g. \`${config.prefix}rate\` or \`${config.prefix}qr <text>\`.` },
    );
}

function successEmbed(title, desc) {
  return baseEmbed({ color: config.colors.success }).setTitle(`✅ ${title}`).setDescription(desc);
}
function errorEmbed(title, desc) {
  return baseEmbed({ color: config.colors.error }).setTitle(`❌ ${title}`).setDescription(desc);
}

function auditLogEmbed(logs, page, totalPages) {
  const embed = baseEmbed().setTitle('📋 Audit Log').setFooter({ text: `${config.brand.footer} • Page ${page}/${totalPages}` });
  if (!logs.length) return embed.setDescription('No audit log entries found.');
  for (const log of logs) {
    embed.addFields({
      name: `${log.action} • ${formatDate(log.timestamp)}`,
      value: `**Admin:** <@${log.adminId}>\n**Old:** \`${JSON.stringify(log.oldValue)}\`\n**New:** \`${JSON.stringify(log.newValue)}\``,
    });
  }
  return embed;
}

function exchangesListEmbed(transactions, page, totalPages, filters = {}) {
  const parts = [];
  if (filters.user) parts.push(`User: <@${filters.user}>`);
  if (filters.type) parts.push(`Type: ${filters.type}`);
  if (filters.status) parts.push(`Status: ${filters.status}`);
  const embed = baseEmbed().setTitle('📂 All Exchanges').setFooter({ text: `${config.brand.footer} • Page ${page}/${totalPages}` });
  if (parts.length) embed.setDescription(`Filters: ${parts.join(' | ')}`);
  if (!transactions.length) return embed.addFields({ name: 'No results', value: 'No exchanges match these filters.' });
  for (const tx of transactions) {
    embed.addFields({
      name: `${tx.transactionId} • ${typeLabel(tx.type)} • ${statusEmoji(tx.status)} ${tx.status}`,
      value: `User: <@${tx.userId}>\nIn: ${formatAmount(tx.type, 'input', tx.inputAmount)} → Out: ${formatAmount(tx.type, 'output', tx.outputAmount)}\nDate: ${formatDate(tx.createdAt)}`,
    });
  }
  return embed;
}

function panelEmbed(s) {
  const line = (e) => (e ? '🟢 Live' : '🔴 Paused');
  return baseEmbed()
    .setTitle(`${config.emojis.crown} CrownX Admin Panel`)
    .setDescription('**Control the exchange in real time.**')
    .addFields(
      { name: 'I2C', value: `${line(s.exchangeEnabled.I2C)}\n₹${s.rates.I2C} = 1 C`, inline: true },
      { name: 'C2I', value: `${line(s.exchangeEnabled.C2I)}\n1 C = ₹${s.rates.C2I}`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Fees', value: `I2C: ${s.fees.I2C}% • C2I: ${s.fees.C2I}%` },
    );
}

function panelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_action:pause:I2C').setLabel('Pause I2C').setEmoji('⏸️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('panel_action:resume:I2C').setLabel('Resume I2C').setEmoji('▶️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('panel_action:pause:C2I').setLabel('Pause C2I').setEmoji('⏸️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('panel_action:resume:C2I').setLabel('Resume C2I').setEmoji('▶️').setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_action:pauseall:ALL').setLabel('Pause All').setEmoji('🛑').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('panel_action:resumeall:ALL').setLabel('Resume All').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('panel_action:auditlog:ALL').setLabel('Audit Log').setEmoji('📋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_action:refresh:ALL').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function confirmCancelRow(type, amount) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_exchange:${type}:${amount}`).setLabel('Confirm').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cancel_exchange').setLabel('Cancel').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}
function exchangeTypeRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('exchange_type:I2C').setLabel('I2C — INR → Crypto').setEmoji('💰').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('exchange_type:C2I').setLabel('C2I — Crypto → INR').setEmoji('🪙').setStyle(ButtonStyle.Secondary),
  );
}
function paginationRow(baseId, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${baseId}:${page - 1}`).setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`${baseId}:${page + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages),
  );
}

const PAGE_SIZE = 5;

// ============================================================
// SLASH COMMANDS
// ============================================================

const commands = new Map();

function addCommand(data, execute) {
  commands.set(data.name, { data, execute });
}

addCommand(
  new SlashCommandBuilder().setName('i2c').setDescription('Create an INR → Crypto exchange request')
    .addNumberOption((o) => o.setName('amount').setDescription('Amount in INR').setRequired(true).setMinValue(0.01)),
  async (interaction) => {
    const amount = interaction.options.getNumber('amount');
    const { error, result } = await quote('I2C', amount);
    if (error) return interaction.reply({ content: `❌ ${error}`, flags: MessageFlags.Ephemeral });
    await interaction.reply({ embeds: [confirmationEmbed(result)], components: [confirmCancelRow('I2C', amount)], flags: MessageFlags.Ephemeral });
  },
);

addCommand(
  new SlashCommandBuilder().setName('c2i').setDescription('Create a Crypto → INR exchange request')
    .addNumberOption((o) => o.setName('amount').setDescription('Amount in Crypto').setRequired(true).setMinValue(0.01)),
  async (interaction) => {
    const amount = interaction.options.getNumber('amount');
    const { error, result } = await quote('C2I', amount);
    if (error) return interaction.reply({ content: `❌ ${error}`, flags: MessageFlags.Ephemeral });
    await interaction.reply({ embeds: [confirmationEmbed(result)], components: [confirmCancelRow('C2I', amount)], flags: MessageFlags.Ephemeral });
  },
);

addCommand(
  new SlashCommandBuilder().setName('exchange').setDescription('Open the general exchange menu'),
  async (interaction) => {
    const embed = baseEmbed()
      .setTitle(`${config.emojis.coin} CrownX Exchange`)
      .setDescription('**Select the type of exchange you would like to perform:**\n\n💰 **I2C** — convert INR into Crypto\n🪙 **C2I** — convert Crypto into INR');
    await interaction.reply({ embeds: [embed], components: [exchangeTypeRow()], flags: MessageFlags.Ephemeral });
  },
);

addCommand(
  new SlashCommandBuilder().setName('calculator').setDescription('Calculate an exchange without creating a transaction')
    .addStringOption((o) => o.setName('type').setDescription('Exchange type').setRequired(true).addChoices({ name: 'I2C — INR → Crypto', value: 'I2C' }, { name: 'C2I — Crypto → INR', value: 'C2I' }))
    .addNumberOption((o) => o.setName('amount').setDescription('Amount to convert').setRequired(true).setMinValue(0.01)),
  async (interaction) => {
    const type = interaction.options.getString('type');
    const amount = interaction.options.getNumber('amount');
    const settings = await getSettings();
    const result = calculate(type, amount, settings.rates, settings.fees);
    await interaction.reply({ embeds: [calculatorEmbed(result)], flags: MessageFlags.Ephemeral });
  },
);

addCommand(
  new SlashCommandBuilder().setName('qr').setDescription('Generate a QR code (e.g. a wallet address or payment link)')
    .addStringOption((o) => o.setName('text').setDescription('Text, URL, or wallet address to encode').setRequired(true).setMaxLength(1000))
    .addBooleanOption((o) => o.setName('private').setDescription('Only show the QR code to you (default: true)')),
  async (interaction) => {
    const text = interaction.options.getString('text');
    const isPrivate = interaction.options.getBoolean('private') ?? true;
    let buffer;
    try {
      buffer = await generateQrBuffer(text);
    } catch (err) {
      console.error('[qr]', err);
      return interaction.reply({ embeds: [errorEmbed('QR Generation Failed', 'Could not generate a QR code for that input.')], flags: MessageFlags.Ephemeral });
    }
    const attachment = new AttachmentBuilder(buffer, { name: 'crownx-qr.png' });
    const embed = baseEmbed()
      .setTitle('📱 QR Code Generated')
      .setDescription(`\`\`\`${text.length > 200 ? `${text.slice(0, 200)}…` : text}\`\`\``)
      .setImage('attachment://crownx-qr.png');
    await interaction.reply({ embeds: [embed], files: [attachment], flags: isPrivate ? MessageFlags.Ephemeral : undefined });
  },
);

addCommand(new SlashCommandBuilder().setName('rate').setDescription('Show live exchange rates'), async (interaction) => {
  await interaction.reply({ embeds: [rateEmbed(await getSettings())] });
});

addCommand(new SlashCommandBuilder().setName('status').setDescription('Show exchange availability and system status'), async (interaction) => {
  await interaction.reply({ embeds: [statusEmbed(await getSettings())] });
});

addCommand(new SlashCommandBuilder().setName('limits').setDescription('Show current exchange limits'), async (interaction) => {
  await interaction.reply({ embeds: [limitsEmbed(await getSettings())] });
});

addCommand(new SlashCommandBuilder().setName('fees').setDescription('Show current exchange fees'), async (interaction) => {
  await interaction.reply({ embeds: [feesEmbed(await getSettings())] });
});

addCommand(new SlashCommandBuilder().setName('help').setDescription('Show the CrownX Helper command list'), async (interaction) => {
  await interaction.reply({ embeds: [helpEmbed()] });
});

addCommand(new SlashCommandBuilder().setName('history').setDescription("Show your previous exchanges"), async (interaction) => {
  const txs = await Transaction.find({ userId: interaction.user.id }).sort({ createdAt: -1 }).limit(PAGE_SIZE);
  if (!txs.length) {
    return interaction.reply({ embeds: [baseEmbed().setTitle(`${config.emojis.coin} Exchange History`).setDescription('You have no exchange history yet.')], flags: MessageFlags.Ephemeral });
  }
  await interaction.reply({ embeds: txs.map(historyCardEmbed), flags: MessageFlags.Ephemeral });
});

addCommand(new SlashCommandBuilder().setName('my-exchanges').setDescription('Show your exchange statistics'), async (interaction) => {
  const txs = await Transaction.find({ userId: interaction.user.id });
  const stats = {
    total: txs.length,
    i2c: txs.filter((t) => t.type === 'I2C').length,
    c2i: txs.filter((t) => t.type === 'C2I').length,
    completed: txs.filter((t) => t.status === 'Completed').length,
    pending: txs.filter((t) => t.status === 'Pending').length,
    cancelled: txs.filter((t) => t.status === 'Cancelled').length,
    inrVolume: txs.reduce((s, t) => s + (t.type === 'I2C' ? t.inputAmount : t.outputAmount), 0),
    cryptoVolume: txs.reduce((s, t) => s + (t.type === 'C2I' ? t.inputAmount : t.outputAmount), 0),
  };
  const embed = baseEmbed()
    .setTitle(`${config.emojis.crown} My Exchange Statistics`)
    .addFields(
      { name: 'Total Exchanges', value: `${stats.total}`, inline: true },
      { name: 'I2C Count', value: `${stats.i2c}`, inline: true },
      { name: 'C2I Count', value: `${stats.c2i}`, inline: true },
      { name: 'Completed', value: `${stats.completed}`, inline: true },
      { name: 'Pending', value: `${stats.pending}`, inline: true },
      { name: 'Cancelled', value: `${stats.cancelled}`, inline: true },
      { name: 'Total INR Volume', value: formatINR(stats.inrVolume), inline: true },
      { name: 'Total Crypto Volume', value: formatCrypto(stats.cryptoVolume), inline: true },
    );
  await interaction.reply({ embeds: [embed] });
});

addCommand(
  new SlashCommandBuilder().setName('transaction').setDescription('Show full details for a transaction')
    .addStringOption((o) => o.setName('id').setDescription('Transaction ID (e.g. CX-7F3A9C21)').setRequired(true)),
  async (interaction) => {
    const id = interaction.options.getString('id').trim().toUpperCase();
    const tx = await Transaction.findOne({ transactionId: id });
    if (!tx) return interaction.reply({ embeds: [errorEmbed('Not Found', `No transaction found with ID \`${id}\`.`)], flags: MessageFlags.Ephemeral });
    if (tx.userId !== interaction.user.id && !isAdmin(interaction.member)) {
      return interaction.reply({ embeds: [errorEmbed('Access Denied', 'You can only view your own transactions.')], flags: MessageFlags.Ephemeral });
    }
    await interaction.reply({ embeds: [transactionDetailEmbed(tx, { showProcessor: true })], flags: MessageFlags.Ephemeral });
  },
);

// ---------- Admin slash commands ----------

addCommand(
  new SlashCommandBuilder().setName('setrate').setDescription('[Admin] Update an exchange rate').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName('type').setDescription('Exchange type').setRequired(true).addChoices({ name: 'I2C', value: 'I2C' }, { name: 'C2I', value: 'C2I' }))
    .addNumberOption((o) => o.setName('rate').setDescription('New rate value').setRequired(true).setMinValue(0.01)),
  async (interaction) => {
    const type = interaction.options.getString('type');
    const rate = interaction.options.getNumber('rate');
    const settings = await getSettings();
    const oldRate = settings.rates[type];
    settings.rates[type] = rate;
    await settings.save();
    await AuditLog.create({ action: 'Rate Changed', oldValue: { type, rate: oldRate }, newValue: { type, rate }, adminId: interaction.user.id });
    await interaction.reply({ embeds: [successEmbed('Rate Updated', `${type} rate changed from **${oldRate}** to **${rate}**.`)], flags: MessageFlags.Ephemeral });
  },
);

addCommand(
  new SlashCommandBuilder().setName('setlimit').setDescription('[Admin] Update exchange limits').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName('type').setDescription('Exchange type').setRequired(true).addChoices({ name: 'I2C', value: 'I2C' }, { name: 'C2I', value: 'C2I' }))
    .addNumberOption((o) => o.setName('minimum').setDescription('New minimum').setRequired(true).setMinValue(0))
    .addNumberOption((o) => o.setName('maximum').setDescription('New maximum').setRequired(true).setMinValue(0)),
  async (interaction) => {
    const type = interaction.options.getString('type');
    const minimum = interaction.options.getNumber('minimum');
    const maximum = interaction.options.getNumber('maximum');
    if (minimum >= maximum) return interaction.reply({ embeds: [errorEmbed('Invalid Limits', 'Minimum must be less than maximum.')], flags: MessageFlags.Ephemeral });
    const settings = await getSettings();
    const oldLimits = { min: settings.limits[type].min, max: settings.limits[type].max };
    settings.limits[type].min = minimum;
    settings.limits[type].max = maximum;
    await settings.save();
    await AuditLog.create({ action: 'Limit Changed', oldValue: { type, ...oldLimits }, newValue: { type, min: minimum, max: maximum }, adminId: interaction.user.id });
    await interaction.reply({ embeds: [successEmbed('Limits Updated', `${type} limits set to **${minimum}** — **${maximum}**.`)], flags: MessageFlags.Ephemeral });
  },
);

addCommand(
  new SlashCommandBuilder().setName('pauseexchange').setDescription('[Admin] Disable an exchange type').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName('type').setDescription('Exchange type (or ALL)').setRequired(true).addChoices({ name: 'I2C', value: 'I2C' }, { name: 'C2I', value: 'C2I' }, { name: 'ALL', value: 'ALL' })),
  async (interaction) => {
    const type = interaction.options.getString('type');
    const settings = await getSettings();
    for (const t of type === 'ALL' ? ['I2C', 'C2I'] : [type]) settings.exchangeEnabled[t] = false;
    await settings.save();
    await AuditLog.create({ action: 'Exchange Paused', oldValue: null, newValue: { type }, adminId: interaction.user.id });
    await interaction.reply({ embeds: [successEmbed('Exchange Paused', `${type} exchange(s) have been disabled.`)], flags: MessageFlags.Ephemeral });
  },
);

addCommand(
  new SlashCommandBuilder().setName('resumeexchange').setDescription('[Admin] Re-enable an exchange type').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName('type').setDescription('Exchange type (or ALL)').setRequired(true).addChoices({ name: 'I2C', value: 'I2C' }, { name: 'C2I', value: 'C2I' }, { name: 'ALL', value: 'ALL' })),
  async (interaction) => {
    const type = interaction.options.getString('type');
    const settings = await getSettings();
    for (const t of type === 'ALL' ? ['I2C', 'C2I'] : [type]) settings.exchangeEnabled[t] = true;
    await settings.save();
    await AuditLog.create({ action: 'Exchange Resumed', oldValue: null, newValue: { type }, adminId: interaction.user.id });
    await interaction.reply({ embeds: [successEmbed('Exchange Resumed', `${type} exchange(s) have been re-enabled.`)], flags: MessageFlags.Ephemeral });
  },
);

addCommand(
  new SlashCommandBuilder().setName('exchanges').setDescription('[Admin] View all exchanges with optional filters').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption((o) => o.setName('user').setDescription('Filter by user'))
    .addStringOption((o) => o.setName('type').setDescription('Filter by type').addChoices({ name: 'I2C', value: 'I2C' }, { name: 'C2I', value: 'C2I' }))
    .addStringOption((o) => o.setName('status').setDescription('Filter by status').addChoices({ name: 'Pending', value: 'Pending' }, { name: 'Completed', value: 'Completed' }, { name: 'Cancelled', value: 'Cancelled' })),
  async (interaction) => {
    const user = interaction.options.getUser('user');
    const type = interaction.options.getString('type');
    const status = interaction.options.getString('status');
    const filter = {};
    if (user) filter.userId = user.id;
    if (type) filter.type = type;
    if (status) filter.status = status;
    const total = await Transaction.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const txs = await Transaction.find(filter).sort({ createdAt: -1 }).limit(PAGE_SIZE);
    const filters = { user: user?.id, type, status };
    const filterKey = encodeURIComponent(JSON.stringify(filters));
    await interaction.reply({
      embeds: [exchangesListEmbed(txs, 1, totalPages, filters)],
      components: totalPages > 1 ? [paginationRow(`exchanges_page:${filterKey}`, 1, totalPages)] : [],
      flags: MessageFlags.Ephemeral,
    });
  },
);

addCommand(
  new SlashCommandBuilder().setName('exchange-info').setDescription('[Admin] Show full transaction details, including processor').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName('id').setDescription('Transaction ID').setRequired(true)),
  async (interaction) => {
    const id = interaction.options.getString('id').trim().toUpperCase();
    const tx = await Transaction.findOne({ transactionId: id });
    if (!tx) return interaction.reply({ embeds: [errorEmbed('Not Found', `No transaction found with ID \`${id}\`.`)], flags: MessageFlags.Ephemeral });
    await interaction.reply({ embeds: [transactionDetailEmbed(tx, { showProcessor: true })], flags: MessageFlags.Ephemeral });
  },
);

addCommand(
  new SlashCommandBuilder().setName('audit-log').setDescription('[Admin] View permanent audit logs').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async (interaction) => {
    const total = await AuditLog.countDocuments();
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const logs = await AuditLog.find().sort({ timestamp: -1 }).limit(PAGE_SIZE);
    await interaction.reply({
      embeds: [auditLogEmbed(logs, 1, totalPages)],
      components: totalPages > 1 ? [paginationRow('auditlog_page', 1, totalPages)] : [],
      flags: MessageFlags.Ephemeral,
    });
  },
);

addCommand(
  new SlashCommandBuilder().setName('panel').setDescription('[Admin] Open the CrownX live control panel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async (interaction) => {
    await interaction.reply({ embeds: [panelEmbed(await getSettings())], components: panelRows(), flags: MessageFlags.Ephemeral });
  },
);

// ============================================================
// BUTTONS
// ============================================================

const buttons = new Map();

buttons.set('exchange_type', async (interaction, [type]) => {
  const modal = new ModalBuilder().setCustomId(`amount_modal:${type}`).setTitle(`${type} Exchange — Enter Amount`);
  const input = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel(type === 'I2C' ? 'INR amount to convert' : 'Crypto amount to convert')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(type === 'I2C' ? 'e.g. 520' : 'e.g. 5')
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
});

buttons.set('confirm_exchange', async (interaction, [type, amountRaw]) => {
  const amount = Number(amountRaw);
  const { error, transaction } = await createTransaction(interaction.user, type, amount);
  if (error) return interaction.update({ embeds: [errorEmbed('Exchange Failed', error)], components: [] });
  await interaction.update({ embeds: [transactionCreatedEmbed(transaction)], components: [] });
});

buttons.set('cancel_exchange', async (interaction) => {
  await interaction.update({ embeds: [baseEmbed({ color: config.colors.cancelled }).setTitle('❌ Exchange Cancelled').setDescription('No transaction was created.')], components: [] });
});

buttons.set('exchanges_page', async (interaction, [filterKey, pageRaw]) => {
  const page = Number(pageRaw);
  const filters = JSON.parse(decodeURIComponent(filterKey));
  const filter = {};
  if (filters.user) filter.userId = filters.user;
  if (filters.type) filter.type = filters.type;
  if (filters.status) filter.status = filters.status;
  const total = await Transaction.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const txs = await Transaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE);
  await interaction.update({ embeds: [exchangesListEmbed(txs, page, totalPages, filters)], components: [paginationRow(`exchanges_page:${filterKey}`, page, totalPages)] });
});

buttons.set('auditlog_page', async (interaction, [pageRaw]) => {
  const page = Number(pageRaw);
  const total = await AuditLog.countDocuments();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const logs = await AuditLog.find().sort({ timestamp: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE);
  await interaction.update({ embeds: [auditLogEmbed(logs, page, totalPages)], components: [paginationRow('auditlog_page', page, totalPages)] });
});

buttons.set('panel_action', async (interaction, [action, type]) => {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '❌ Admins only.', flags: MessageFlags.Ephemeral });

  if (action === 'auditlog') {
    const total = await AuditLog.countDocuments();
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const logs = await AuditLog.find().sort({ timestamp: -1 }).limit(PAGE_SIZE);
    return interaction.reply({
      embeds: [auditLogEmbed(logs, 1, totalPages)],
      components: totalPages > 1 ? [paginationRow('auditlog_page', 1, totalPages)] : [],
      flags: MessageFlags.Ephemeral,
    });
  }

  const settings = await getSettings();
  if (action === 'pause' || action === 'resume') {
    settings.exchangeEnabled[type] = action === 'resume';
    await settings.save();
    await AuditLog.create({ action: action === 'pause' ? 'Exchange Paused' : 'Exchange Resumed', oldValue: null, newValue: { type }, adminId: interaction.user.id });
  } else if (action === 'pauseall' || action === 'resumeall') {
    const enabled = action === 'resumeall';
    settings.exchangeEnabled.I2C = enabled;
    settings.exchangeEnabled.C2I = enabled;
    await settings.save();
    await AuditLog.create({ action: enabled ? 'Exchange Resumed' : 'Exchange Paused', oldValue: null, newValue: { type: 'ALL' }, adminId: interaction.user.id });
  }

  const fresh = await getSettings();
  await interaction.update({ embeds: [panelEmbed(fresh)], components: panelRows() });
});

// ============================================================
// MODALS
// ============================================================

async function handleModalSubmit(interaction) {
  const [id, type] = interaction.customId.split(':');
  if (id !== 'amount_modal') return false;

  const raw = interaction.fields.getTextInputValue('amount');
  const amount = Number(raw);
  if (Number.isNaN(amount) || amount <= 0) {
    await interaction.reply({ content: '❌ Please enter a valid positive number.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const { error, result } = await quote(type, amount);
  if (error) {
    await interaction.reply({ content: `❌ ${error}`, flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.reply({ embeds: [confirmationEmbed(result)], components: [confirmCancelRow(type, amount)], flags: MessageFlags.Ephemeral });
  return true;
}

// ============================================================
// $ PREFIX COMMANDS
// ============================================================

function needAdmin(message) {
  if (!isAdmin(message.member)) {
    message.reply({ embeds: [errorEmbed('Access Denied', 'This command is for admins only.')] });
    return false;
  }
  return true;
}

async function handlePrefixCommand(message) {
  const withoutPrefix = message.content.slice(config.prefix.length).trim();
  const [cmd, ...args] = withoutPrefix.split(/\s+/);
  const name = cmd.toLowerCase();

  switch (name) {
    case 'help':
      return message.reply({ embeds: [helpEmbed()] });
    case 'rate':
      return message.reply({ embeds: [rateEmbed(await getSettings())] });
    case 'status':
      return message.reply({ embeds: [statusEmbed(await getSettings())] });
    case 'limits':
      return message.reply({ embeds: [limitsEmbed(await getSettings())] });
    case 'fees':
      return message.reply({ embeds: [feesEmbed(await getSettings())] });

    case 'calculator': {
      const type = args[0]?.toUpperCase();
      const amount = Number(args[1]);
      if (!['I2C', 'C2I'].includes(type) || !amount || amount <= 0) return message.reply(`❌ Usage: \`${config.prefix}calculator <I2C|C2I> <amount>\``);
      const settings = await getSettings();
      return message.reply({ embeds: [calculatorEmbed(calculate(type, amount, settings.rates, settings.fees))] });
    }

    case 'i2c':
    case 'c2i':
    case 'exchange': {
      const type = name === 'exchange' ? args[0]?.toUpperCase() : name.toUpperCase();
      const amount = Number(name === 'exchange' ? args[1] : args[0]);
      if (!['I2C', 'C2I'].includes(type) || !amount || amount <= 0) {
        return message.reply(`❌ Usage: \`${config.prefix}${name}${name === 'exchange' ? ' <I2C|C2I>' : ''} <amount>\``);
      }
      const { error, result } = await quote(type, amount);
      if (error) return message.reply({ embeds: [errorEmbed('Exchange Unavailable', error)] });
      return message.reply({ embeds: [confirmationEmbed(result)], components: [confirmCancelRow(type, amount)] });
    }

    case 'qr': {
      const text = args.join(' ').trim();
      if (!text) return message.reply(`❌ Usage: \`${config.prefix}qr <text or link>\``);
      let buffer;
      try {
        buffer = await generateQrBuffer(text);
      } catch (err) {
        console.error('[$qr]', err);
        return message.reply({ embeds: [errorEmbed('QR Generation Failed', 'Could not generate a QR code for that input.')] });
      }
      const attachment = new AttachmentBuilder(buffer, { name: 'crownx-qr.png' });
      const embed = baseEmbed().setTitle('📱 QR Code Generated').setDescription(`\`\`\`${text.length > 200 ? `${text.slice(0, 200)}…` : text}\`\`\``).setImage('attachment://crownx-qr.png');
      return message.reply({ embeds: [embed], files: [attachment] });
    }

    case 'history': {
      const txs = await Transaction.find({ userId: message.author.id }).sort({ createdAt: -1 }).limit(PAGE_SIZE);
      if (!txs.length) return message.reply({ embeds: [baseEmbed().setTitle('💱 Exchange History').setDescription('You have no exchange history yet.')] });
      return message.reply({ embeds: txs.map(historyCardEmbed) });
    }

    case 'my-exchanges':
    case 'myexchanges': {
      const txs = await Transaction.find({ userId: message.author.id });
      const stats = {
        total: txs.length,
        i2c: txs.filter((t) => t.type === 'I2C').length,
        c2i: txs.filter((t) => t.type === 'C2I').length,
        completed: txs.filter((t) => t.status === 'Completed').length,
        pending: txs.filter((t) => t.status === 'Pending').length,
        cancelled: txs.filter((t) => t.status === 'Cancelled').length,
        inrVolume: txs.reduce((s, t) => s + (t.type === 'I2C' ? t.inputAmount : t.outputAmount), 0),
        cryptoVolume: txs.reduce((s, t) => s + (t.type === 'C2I' ? t.inputAmount : t.outputAmount), 0),
      };
      const embed = baseEmbed()
        .setTitle(`${config.emojis.crown} My Exchange Statistics`)
        .addFields(
          { name: 'Total Exchanges', value: `${stats.total}`, inline: true },
          { name: 'I2C Count', value: `${stats.i2c}`, inline: true },
          { name: 'C2I Count', value: `${stats.c2i}`, inline: true },
          { name: 'Completed', value: `${stats.completed}`, inline: true },
          { name: 'Pending', value: `${stats.pending}`, inline: true },
          { name: 'Cancelled', value: `${stats.cancelled}`, inline: true },
          { name: 'Total INR Volume', value: formatINR(stats.inrVolume), inline: true },
          { name: 'Total Crypto Volume', value: formatCrypto(stats.cryptoVolume), inline: true },
        );
      return message.reply({ embeds: [embed] });
    }

    case 'transaction': {
      const id = args[0]?.trim().toUpperCase();
      if (!id) return message.reply(`❌ Usage: \`${config.prefix}transaction <id>\``);
      const tx = await Transaction.findOne({ transactionId: id });
      if (!tx) return message.reply({ embeds: [errorEmbed('Not Found', `No transaction found with ID \`${id}\`.`)] });
      if (tx.userId !== message.author.id && !isAdmin(message.member)) return message.reply({ embeds: [errorEmbed('Access Denied', 'You can only view your own transactions.')] });
      return message.reply({ embeds: [transactionDetailEmbed(tx, { showProcessor: true })] });
    }

    case 'panel': {
      if (!needAdmin(message)) return null;
      return message.reply({ embeds: [panelEmbed(await getSettings())], components: panelRows() });
    }

    case 'setrate': {
      if (!needAdmin(message)) return null;
      const type = args[0]?.toUpperCase();
      const rate = Number(args[1]);
      if (!['I2C', 'C2I'].includes(type) || !rate || rate <= 0) return message.reply(`❌ Usage: \`${config.prefix}setrate <I2C|C2I> <rate>\``);
      const settings = await getSettings();
      const oldRate = settings.rates[type];
      settings.rates[type] = rate;
      await settings.save();
      await AuditLog.create({ action: 'Rate Changed', oldValue: { type, rate: oldRate }, newValue: { type, rate }, adminId: message.author.id });
      return message.reply({ embeds: [successEmbed('Rate Updated', `${type} rate changed from **${oldRate}** to **${rate}**.`)] });
    }

    case 'setlimit': {
      if (!needAdmin(message)) return null;
      const type = args[0]?.toUpperCase();
      const min = Number(args[1]);
      const max = Number(args[2]);
      if (!['I2C', 'C2I'].includes(type) || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) return message.reply(`❌ Usage: \`${config.prefix}setlimit <I2C|C2I> <min> <max>\``);
      const settings = await getSettings();
      const oldLimits = { min: settings.limits[type].min, max: settings.limits[type].max };
      settings.limits[type].min = min;
      settings.limits[type].max = max;
      await settings.save();
      await AuditLog.create({ action: 'Limit Changed', oldValue: { type, ...oldLimits }, newValue: { type, min, max }, adminId: message.author.id });
      return message.reply({ embeds: [successEmbed('Limits Updated', `${type} limits set to **${min}** — **${max}**.`)] });
    }

    case 'pauseexchange': {
      if (!needAdmin(message)) return null;
      const type = args[0]?.toUpperCase();
      if (!['I2C', 'C2I', 'ALL'].includes(type)) return message.reply(`❌ Usage: \`${config.prefix}pauseexchange <I2C|C2I|ALL>\``);
      const settings = await getSettings();
      for (const t of type === 'ALL' ? ['I2C', 'C2I'] : [type]) settings.exchangeEnabled[t] = false;
      await settings.save();
      await AuditLog.create({ action: 'Exchange Paused', oldValue: null, newValue: { type }, adminId: message.author.id });
      return message.reply({ embeds: [successEmbed('Exchange Paused', `${type} exchange(s) have been disabled.`)] });
    }

    case 'resumeexchange': {
      if (!needAdmin(message)) return null;
      const type = args[0]?.toUpperCase();
      if (!['I2C', 'C2I', 'ALL'].includes(type)) return message.reply(`❌ Usage: \`${config.prefix}resumeexchange <I2C|C2I|ALL>\``);
      const settings = await getSettings();
      for (const t of type === 'ALL' ? ['I2C', 'C2I'] : [type]) settings.exchangeEnabled[t] = true;
      await settings.save();
      await AuditLog.create({ action: 'Exchange Resumed', oldValue: null, newValue: { type }, adminId: message.author.id });
      return message.reply({ embeds: [successEmbed('Exchange Resumed', `${type} exchange(s) have been re-enabled.`)] });
    }

    case 'exchanges': {
      if (!needAdmin(message)) return null;
      const filter = {};
      for (const a of args) {
        const up = a.toUpperCase();
        if (['I2C', 'C2I'].includes(up)) filter.type = up;
        else if (['PENDING', 'COMPLETED', 'CANCELLED'].includes(up)) filter.status = up[0] + up.slice(1).toLowerCase();
      }
      const total = await Transaction.countDocuments(filter);
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const txs = await Transaction.find(filter).sort({ createdAt: -1 }).limit(PAGE_SIZE);
      const filterKey = encodeURIComponent(JSON.stringify(filter));
      return message.reply({
        embeds: [exchangesListEmbed(txs, 1, totalPages, filter)],
        components: totalPages > 1 ? [paginationRow(`exchanges_page:${filterKey}`, 1, totalPages)] : [],
      });
    }

    case 'exchange-info':
    case 'exchangeinfo': {
      if (!needAdmin(message)) return null;
      const id = args[0]?.trim().toUpperCase();
      if (!id) return message.reply(`❌ Usage: \`${config.prefix}exchange-info <id>\``);
      const tx = await Transaction.findOne({ transactionId: id });
      if (!tx) return message.reply({ embeds: [errorEmbed('Not Found', `No transaction found with ID \`${id}\`.`)] });
      return message.reply({ embeds: [transactionDetailEmbed(tx, { showProcessor: true })] });
    }

    case 'audit-log':
    case 'auditlog': {
      if (!needAdmin(message)) return null;
      const total = await AuditLog.countDocuments();
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const logs = await AuditLog.find().sort({ timestamp: -1 }).limit(PAGE_SIZE);
      return message.reply({
        embeds: [auditLogEmbed(logs, 1, totalPages)],
        components: totalPages > 1 ? [paginationRow('auditlog_page', 1, totalPages)] : [],
      });
    }

    default:
      return null;
  }
}

// ============================================================
// SLASH COMMAND DEPLOYMENT (node index.js --deploy)
// ============================================================

async function deployCommands() {
  if (!config.clientId) {
    console.error('❌ Missing CLIENT_ID in your .env / Railway variables.');
    process.exit(1);
  }
  const rest = new REST().setToken(config.token);
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);
  console.log(`🚀 Deploying ${body.length} slash commands${config.guildId ? ' (guild)' : ' (global)'}...`);
  await rest.put(route, { body });
  console.log('✅ Slash commands deployed successfully.');
}

// ============================================================
// CLIENT + EVENTS
// ============================================================

async function main() {
  if (process.argv.includes('--deploy')) {
    await deployCommands();
    process.exit(0);
  }

  try {
    await mongoose.connect(config.mongoUri);
    console.log('🗄️  Connected to MongoDB');
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });

  client.once('ready', (c) => {
    console.log(`👑 CrownX Helper online as ${c.user.tag}`);
    c.user.setPresence({ activities: [{ name: `${config.prefix}help • Crypto ⇄ INR`, type: ActivityType.Watching }], status: 'online' });
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = commands.get(interaction.commandName);
        if (!command) return;
        const remaining = checkCooldown(interaction.user.id, interaction.commandName);
        if (remaining > 0) {
          return interaction.reply({ content: `⏳ Please wait ${remaining}s before using \`/${interaction.commandName}\` again.`, flags: MessageFlags.Ephemeral });
        }
        await command.execute(interaction);
        return;
      }
      if (interaction.isButton()) {
        const [id, ...args] = interaction.customId.split(':');
        const handler = buttons.get(id);
        if (!handler) return;
        await handler(interaction, args);
        return;
      }
      if (interaction.isModalSubmit()) {
        const handled = await handleModalSubmit(interaction);
        if (!handled) await interaction.reply({ content: '❌ Unknown form submission.', flags: MessageFlags.Ephemeral });
        return;
      }
    } catch (err) {
      console.error('[interactionCreate] Error:', err);
      const payload = { embeds: [errorEmbed('Something Went Wrong', 'An unexpected error occurred while processing this action.')], flags: MessageFlags.Ephemeral };
      try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else if (interaction.isRepliable?.()) await interaction.reply(payload);
      } catch (e2) {
        console.error('[interactionCreate] Failed to report error:', e2);
      }
    }
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(config.prefix)) return;
    try {
      await handlePrefixCommand(message);
    } catch (err) {
      console.error('[messageCreate] Error:', err);
      await message.reply('❌ Something went wrong running that command.').catch(() => {});
    }
  });

  await client.login(config.token);

  // Tiny health-check server — Railway is happiest when something
  // responds on PORT. No-op locally where PORT isn't set.
  if (process.env.PORT) {
    http
      .createServer((req, res) => {
        const online = client.isReady();
        res.writeHead(online ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: online ? 'online' : 'starting', bot: client.user?.tag || null }));
      })
      .listen(process.env.PORT, () => console.log(`🌐 Keep-alive server listening on port ${process.env.PORT}`));
  }
}

main();

process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection:', err));
