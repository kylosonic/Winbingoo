require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;
const SERVER_URL = 'http://localhost:3001';

bot.command('start', (ctx) => {
  ctx.reply('Welcome to WinBingo! 🇪🇹', Markup.inlineKeyboard([
    [Markup.button.webApp('🎰 PLAY NOW', process.env.WEB_APP_URL)],
    [Markup.button.callback('📥 Deposit', 'deposit_info')]
  ]));
});

bot.action('deposit_info', (ctx) => {
  ctx.reply(`
📥 *DEPOSIT INSTRUCTIONS*
1. Send ETB to Telebirr: 0911223344
2. Take a screenshot of the SMS.
3. Send the photo here.
  `, { parse_mode: 'Markdown' });
});

// Handle Photos (Deposit Proofs)
bot.on('photo', async (ctx) => {
  // Forward to Admin
  await ctx.telegram.forwardMessage(ADMIN_ID, ctx.message.message_id);
  
  await ctx.telegram.sendMessage(ADMIN_ID, `User: ${ctx.from.first_name} (ID: ${ctx.from.id})\nSent a deposit proof.`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ 50 ETB', callback_data: `d_${ctx.from.id}_50` },
          { text: '✅ 100 ETB', callback_data: `d_${ctx.from.id}_100` },
          { text: '✅ 500 ETB', callback_data: `d_${ctx.from.id}_500` }
        ],
        [{ text: '❌ Reject', callback_data: `reject_${ctx.from.id}` }]
      ]
    }
  });
  ctx.reply('Proof received! Waiting for admin approval.');
});

// Admin Approval Logic
bot.action(/d_(\d+)_(\d+)/, async (ctx) => {
  const [_, userId, amount] = ctx.match;
  try {
    await axios.post(`${SERVER_URL}/api/deposit`, { telegramId: userId, amount: parseInt(amount) });
    await ctx.telegram.sendMessage(userId, `✅ Your account has been credited with ${amount} ETB!`);
    ctx.editMessageText(`Processed: Added ${amount} ETB to ${userId}`);
  } catch (e) {
    ctx.reply('Server Error: ' + e.message);
  }
});

bot.launch();
console.log('🤖 Bot Started');