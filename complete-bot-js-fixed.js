/**
 * Web3 Guild Bot - Исправленная версия
 * Telegram бот для модерации и геймификации
 * Исправления: производительность, блокировки event loop, error handling
 */

const { Telegraf, Markup, session } = require('telegraf');
const { message } = require('telegraf/filters');
const mongoose = require('mongoose');
const config = require('./config');
require('dotenv').config();

// Добавляем timeout для операций MongoDB
mongoose.set('maxTimeMS', 5000); // 5 секунд максимум на операцию

// Подключение к MongoDB с улучшенными настройками
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/web3_guild_bot', {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  bufferCommands: false,
  bufferMaxEntries: 0
})
  .then(() => console.log('✅ Подключение к MongoDB установлено'))
  .catch(err => console.error('❌ Ошибка подключения к MongoDB:', err));

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);

// ==================== СХЕМЫ БАЗЫ ДАННЫХ ====================

// Схема пользователя
const userSchema = new mongoose.Schema({
  user_id: { type: Number, required: true, unique: true, index: true },
  username: { type: String, default: null, index: true },
  first_name: { type: String, default: '' },
  points: { type: Number, default: 0, index: true },
  level: { type: Number, default: 1 },
  warnings: { type: Number, default: 0 },
  is_muted: { type: Boolean, default: false, index: true },
  mute_until: { type: Date, default: null },
  is_banned: { type: Boolean, default: false, index: true },
  captcha_verified: { type: Boolean, default: false },
  captcha_answer: { type: Number, default: null },
  captcha_message_id: { type: Number, default: null },
  join_date: { type: Date, default: Date.now },
  last_activity: { type: Date, default: Date.now, index: true },
  messages_count: { type: Number, default: 0 }
});

// Схема логов
const logSchema = new mongoose.Schema({
  user_id: { type: Number, required: true, index: true },
  admin_id: { type: Number, required: true },
  action: { type: String, required: true, index: true },
  reason: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now, index: true },
  details: { type: mongoose.Schema.Types.Mixed, default: {} }
});

// Схема для сохранения отложенных сообщений
const pendingMessageSchema = new mongoose.Schema({
  user_id: { type: Number, required: true, index: true },
  username: { type: String, default: '' },
  first_name: { type: String, default: '' },
  message_text: { type: String, required: true },
  message_type: { type: String, default: 'text' },
  chat_id: { type: Number, required: true },
  created_at: { type: Date, default: Date.now },
  expires_at: { 
    type: Date, 
    default: () => new Date(Date.now() + config.moderation.pendingMessageHours * 60 * 60 * 1000),
    index: true
  }
});

const User = mongoose.model('User', userSchema);
const Log = mongoose.model('Log', logSchema);
const PendingMessage = mongoose.model('PendingMessage', pendingMessageSchema);

// Очистка истёкших отложенных сообщений каждый час
setInterval(async () => {
  try {
    const deleted = await PendingMessage.deleteMany({ expires_at: { $lt: new Date() } }).maxTimeMS(5000);
    if (deleted.deletedCount > 0) {
      console.log(`🗑️ Удалено ${deleted.deletedCount} истёкших черновиков`);
    }
  } catch (error) {
    console.error('Ошибка очистки истёкших сообщений:', error);
  }
}, 60 * 60 * 1000);

// ==================== MIDDLEWARE ====================
// Убираем session - может вызывать блокировки
// bot.use(session());

// Добавляем middleware для логирования производительности
bot.use(async (ctx, next) => {
  const start = Date.now();
  try {
    await next();
  } catch (error) {
    console.error('Ошибка в middleware:', error);
  } finally {
    const ms = Date.now() - start;
    if (ms > 1000) { // Логируем только медленные операции
      console.log(`⏱️ Медленная операция: ${ms}ms`);
    }
  }
});

// ==================== ОБРАБОТКА НОВЫХ УЧАСТНИКОВ ====================
bot.on(message('new_chat_members'), async (ctx) => {
  const newMembers = ctx.message.new_chat_members;
  
  // Обрабатываем асинхронно, не блокируя
  for (const member of newMembers) {
    if (member.is_bot) continue;
    
    // Используем setImmediate для избежания блокировки
    setImmediate(async () => {
      try {
        await User.findOneAndUpdate(
          { user_id: member.id },
          {
            user_id: member.id,
            username: member.username || null,
            first_name: member.first_name || '',
            join_date: new Date(),
            last_activity: new Date()
          },
          { upsert: true, maxTimeMS: 3000 }
        );

        console.log(`➕ Новый участник: ${member.first_name} (@${member.username || 'нет'}, ID: ${member.id})`);
        
      } catch (error) {
        console.error('Ошибка при обработке нового участника:', error);
      }
    });
  }
});

// ==================== ОБРАБОТКА СООБЩЕНИЙ ====================
bot.on(message('text'), async (ctx) => {
  // Игнорируем сообщения в личке и от ботов
  if (ctx.chat.type === 'private' || ctx.from.is_bot) return;
  
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const messageId = ctx.message.message_id;
  
  // Используем try-catch с timeout
  try {
    // Получаем или создаём данные пользователя с timeout
    let userData = await Promise.race([
      User.findOne({ user_id: userId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 3000))
    ]);
    
    if (!userData) {
      userData = new User({
        user_id: userId,
        username: ctx.from.username || null,
        first_name: ctx.from.first_name || '',
        join_date: new Date(),
        last_activity: new Date()
      });
      
      // Сохраняем асинхронно
      setImmediate(async () => {
        try {
          await userData.save();
        } catch (error) {
          console.error('Ошибка сохранения нового пользователя:', error);
        }
      });
    }

    // Проверка на верификацию капчи
    if (!userData.captcha_verified) {
      await ctx.deleteMessage(messageId).catch(() => {}); // Игнорируем ошибки удаления
      
      // Сохраняем сообщение как черновик асинхронно
      setImmediate(() => savePendingMessage(userId, ctx.from.username || '', ctx.from.first_name || '', text, ctx.chat.id));
      
      // Показываем капчу
      await showCaptcha(ctx, ctx.from);
      return;
    }

    // Проверяем администратора с кешированием
    const isAdminUser = await isAdmin(ctx, userId);
    
    if (!isAdminUser) {
      // Проверка на мат
      if (checkProfanity(text)) { // Делаем синхронной
        await handleViolation(ctx, userData, 'Использование нецензурной лексики', messageId);
        return;
      }

      // Проверка ссылок только для новых пользователей (менее 14 дней)
      const daysSinceJoin = (new Date() - userData.join_date) / (1000 * 60 * 60 * 24);
      if (daysSinceJoin < config.moderation.linkRestrictionDays) {
        if (hasLinks(text)) {
          await ctx.deleteMessage(messageId).catch(() => {});
          
          const daysLeft = Math.ceil(config.moderation.linkRestrictionDays - daysSinceJoin);
          const restrictMsg = await ctx.reply(
            `⚠️ @${ctx.from.username || ctx.from.first_name}, ссылки можно отправлять только через ${daysLeft} дней после присоединения к группе.`,
            { reply_to_message_id: messageId }
          ).catch(() => null);
          
          if (restrictMsg) {
            deleteMessageLater(ctx, restrictMsg.message_id, 30);
          }
          return;
        }
      }
    }
    
    // Начисление баллов за сообщение (асинхронно)
    if (text.split(' ').length >= 3) {
      setImmediate(() => updateUserPoints(userData, config.pointsSettings.message, 'Сообщение'));
    }

    // Обновляем активность асинхронно
    setImmediate(async () => {
      try {
        await User.updateOne(
          { user_id: userId },
          { 
            last_activity: new Date(),
            $inc: { messages_count: 1 }
          },
          { maxTimeMS: 2000 }
        );
      } catch (error) {
        console.error('Ошибка обновления активности:', error);
      }
    });

  } catch (error) {
    console.error('Ошибка обработки сообщения:', error);
  }
});

// ==================== ФУНКЦИЯ ПОКАЗА CAPTCHA ====================
async function showCaptcha(ctx, user) {
  try {
    const num1 = Math.floor(Math.random() * 10) + 1;
    const num2 = Math.floor(Math.random() * 10) + 1;
    const correctAnswer = num1 + num2;

    const captchaText = `🔐 @${user.username || user.first_name}, добро пожаловать!\n\n` +
      `Для начала общения решите пример:\n` +
      `**${num1} + ${num2} = ?**\n\n` +
      `Ваше сообщение сохранено и будет опубликовано после проверки.`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('1', `captcha_${user.id}_1`),
        Markup.button.callback('5', `captcha_${user.id}_5`),
        Markup.button.callback(`${correctAnswer}`, `captcha_${user.id}_${correctAnswer}`),
        Markup.button.callback('15', `captcha_${user.id}_15`)
      ],
      [
        Markup.button.callback('7', `captcha_${user.id}_7`),
        Markup.button.callback('21', `captcha_${user.id}_21`),
        Markup.button.callback('9', `captcha_${user.id}_9`),
        Markup.button.callback('12', `captcha_${user.id}_12`)
      ]
    ]);

    const captchaMsg = await ctx.reply(captchaText, keyboard);
    
    // Сохраняем правильный ответ в базе данных асинхронно
    setImmediate(async () => {
      try {
        await User.findOneAndUpdate(
          { user_id: user.id },
          { 
            captcha_answer: correctAnswer,
            captcha_message_id: captchaMsg.message_id
          },
          { maxTimeMS: 2000 }
        );
      } catch (error) {
        console.error('Ошибка сохранения капчи:', error);
      }
    });

  } catch (error) {
    console.error('Ошибка показа капчи:', error);
  }
}

// ==================== ОБРАБОТКА CALLBACK КНОПОК CAPTCHA ====================
bot.action(/captcha_(\d+)_(\d+)/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  const userAnswer = parseInt(ctx.match[2]);
  
  // Проверяем, что пользователь отвечает на свою капчу
  if (ctx.from.id !== userId) {
    await ctx.answerCbQuery('❌ Это не ваша капча!').catch(() => {});
    return;
  }
  
  try {
    const userData = await Promise.race([
      User.findOne({ user_id: userId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 2000))
    ]);
    
    if (!userData) {
      await ctx.answerCbQuery('❌ Ошибка: пользователь не найден').catch(() => {});
      return;
    }

    if (userData.captcha_verified) {
      await ctx.answerCbQuery('✅ Вы уже проверены!').catch(() => {});
      return;
    }

    if (userAnswer === userData.captcha_answer) {
      // Правильный ответ
      userData.captcha_verified = true;
      
      // Сохраняем асинхронно
      setImmediate(async () => {
        try {
          await userData.save();
        } catch (error) {
          console.error('Ошибка сохранения верификации:', error);
        }
      });

      await ctx.answerCbQuery('✅ Правильно! Добро пожаловать!').catch(() => {});
      
      // Удаляем сообщение с капчей
      await ctx.deleteMessage().catch(() => {});

      // Публикуем сохранённое сообщение асинхронно
      setImmediate(() => publishPendingMessage(ctx, userId));

      // Приветствие
      const welcomeMsg = await ctx.reply(
        `🎉 @${ctx.from.username || ctx.from.first_name} успешно прошёл проверку и теперь может участвовать в обсуждениях!`
      ).catch(() => null);
      
      if (welcomeMsg) {
        deleteMessageLater(ctx, welcomeMsg.message_id, 60);
      }

      // Логируем асинхронно
      setImmediate(() => logAction(userId, 0, 'captcha_passed', 'Успешно прошёл капчу'));
      
      console.log(`✅ Капча пройдена: ${ctx.from.first_name} (ID: ${userId})`);
      
    } else {
      // Неправильный ответ
      await ctx.answerCbQuery('❌ Неправильно! Попробуйте ещё раз.').catch(() => {});
      console.log(`❌ Неправильный ответ капчи: ${ctx.from.first_name} (ID: ${userId}), ответил ${userAnswer}, правильно: ${userData.captcha_answer}`);
    }

  } catch (error) {
    console.error('Ошибка обработки капчи:', error);
    await ctx.answerCbQuery('❌ Произошла ошибка').catch(() => {});
  }
});

// ==================== ФУНКЦИИ ДЛЯ РАБОТЫ С ОТЛОЖЕННЫМИ СООБЩЕНИЯМИ ====================
async function savePendingMessage(userId, username, firstName, messageText, chatId) {
  try {
    // Удаляем предыдущие отложенные сообщения этого пользователя
    await PendingMessage.deleteMany({ user_id: userId }).maxTimeMS(2000);
    
    // Сохраняем новое сообщение
    const pendingMessage = new PendingMessage({
      user_id: userId,
      username: username,
      first_name: firstName,
      message_text: messageText,
      chat_id: chatId
    });
    
    await pendingMessage.save();
    console.log(`💾 Сообщение сохранено как черновик: ${firstName} (ID: ${userId})`);
  } catch (error) {
    console.error('Ошибка сохранения отложенного сообщения:', error);
  }
}

async function publishPendingMessage(ctx, userId) {
  try {
    const pendingMessage = await PendingMessage.findOne({ user_id: userId }).maxTimeMS(2000);
    
    if (pendingMessage) {
      // Публикуем сохранённое сообщение
      await ctx.reply(
        `📝 Сообщение от @${pendingMessage.username || pendingMessage.first_name}:\n\n${pendingMessage.message_text}`
      ).catch(() => {});
      
      // Удаляем из черновиков асинхронно
      setImmediate(async () => {
        try {
          await PendingMessage.deleteOne({ user_id: userId });
        } catch (error) {
          console.error('Ошибка удаления черновика:', error);
        }
      });
      
      console.log(`📤 Опубликовано отложенное сообщение: ${pendingMessage.first_name} (ID: ${userId})`);
    }
  } catch (error) {
    console.error('Ошибка публикации отложенного сообщения:', error);
  }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

// Функция проверки наличия ссылок (синхронная)
function hasLinks(text) {
  const urlPatterns = [
    /https?:\/\/[^\s]+/gi,           // http://site.com
    /www\.[^\s]+/gi,                 // www.site.com  
    /t\.me\/[^\s]+/gi,               // t.me/channel
    /@[a-zA-Z0-9_]+\.(?:com|org|net|io|co|ru|tv|me|bot)/gi  // email@site.com
  ];
  
  return urlPatterns.some(pattern => pattern.test(text));
}

// Функция проверки на мат (синхронная)
function checkProfanity(text) {
  const lowerText = text.toLowerCase();
  return config.blacklistWords.some(word => lowerText.includes(word));
}

// Функция обработки нарушений
async function handleViolation(ctx, userData, reason, messageId) {
  try {
    // Удаляем нарушающее сообщение
    await ctx.deleteMessage(messageId).catch(() => {});
    
    // Увеличиваем количество предупреждений
    userData.warnings += 1;
    
    // Штрафные баллы асинхронно
    setImmediate(() => updateUserPoints(userData, config.pointsSettings.spamPenalty, reason));
    
    if (userData.warnings >= config.moderation.warningThreshold) {
      // Мут пользователя
      const muteUntil = new Date(Date.now() + config.moderation.muteDurationMinutes * 60 * 1000);
      userData.is_muted = true;
      userData.mute_until = muteUntil;
      userData.warnings = 0; // Сбрасываем предупреждения после мута
      
      await ctx.restrictChatMember(userData.user_id, {
        permissions: { can_send_messages: false },
        until_date: Math.floor(muteUntil.getTime() / 1000)
      }).catch(() => {});
      
      const muteMsg = await ctx.reply(
        `🔇 @${ctx.from.username || ctx.from.first_name} получил мут на ${config.moderation.muteDurationMinutes} минут за многократные нарушения.`
      ).catch(() => null);
      
      if (muteMsg) {
        deleteMessageLater(ctx, muteMsg.message_id, config.moderation.autoDeleteMinutes * 60);
      }
      
      setImmediate(() => logAction(userData.user_id, 0, 'mute', `Автоматический мут за ${reason}`));
      
    } else {
      // Предупреждение
      const warningsLeft = config.moderation.warningThreshold - userData.warnings;
      const warningMsg = await ctx.reply(
        `⚠️ @${ctx.from.username || ctx.from.first_name}, предупреждение за: ${reason}\n` +
        `Предупреждений: ${userData.warnings}/${config.moderation.warningThreshold}\n` +
        `До мута осталось: ${warningsLeft}`,
        { reply_to_message_id: messageId }
      ).catch(() => null);
      
      if (warningMsg) {
        deleteMessageLater(ctx, warningMsg.message_id, config.moderation.autoDeleteMinutes * 60);
      }
      
      setImmediate(() => logAction(userData.user_id, 0, 'warning', reason));
    }
    
    // Сохраняем асинхронно
    setImmediate(async () => {
      try {
        await userData.save();
      } catch (error) {
        console.error('Ошибка сохранения нарушения:', error);
      }
    });
    
  } catch (error) {
    console.error('Ошибка обработки нарушения:', error);
  }
}

// Функция обновления баллов пользователя (упрощённая)
async function updateUserPoints(userData, points, reason) {
  try {
    const oldPoints = userData.points;
    
    userData.points += points;
    
    // Не даём баллам уйти в минус
    if (userData.points < 0) {
      userData.points = 0;
    }
    
    // Обновляем уровень
    userData.level = calculateLevel(userData.points);
    
    await userData.save();
    
    console.log(`💎 ${userData.first_name}: ${points > 0 ? '+' : ''}${points} баллов за ${reason} (${oldPoints} → ${userData.points})`);
    
  } catch (error) {
    console.error('Ошибка обновления баллов:', error);
  }
}

// Функция расчёта уровня (синхронная)
function calculateLevel(points) {
  for (let i = config.levelThresholds.length - 1; i >= 0; i--) {
    if (points >= config.levelThresholds[i].points) {
      return config.levelThresholds[i].level;
    }
  }
  return 1;
}

// Кеш для админов (избегаем частых запросов к API)
const adminCache = new Map();
const ADMIN_CACHE_TTL = 5 * 60 * 1000; // 5 минут

// Функция проверки администратора с кешированием
async function isAdmin(ctx, userId) {
  const cacheKey = `${ctx.chat.id}_${userId}`;
  const cached = adminCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < ADMIN_CACHE_TTL) {
    return cached.isAdmin;
  }
  
  try {
    const member = await ctx.getChatMember(userId);
    const isAdminResult = ['creator', 'administrator'].includes(member.status);
    
    // Кешируем результат
    adminCache.set(cacheKey, {
      isAdmin: isAdminResult,
      timestamp: Date.now()
    });
    
    return isAdminResult;
  } catch (error) {
    // В случае ошибки считаем не админом
    return false;
  }
}

// Функция автоудаления сообщений
function deleteMessageLater(ctx, messageId, delaySeconds) {
  setTimeout(async () => {
    try {
      await ctx.deleteMessage(messageId);
    } catch (error) {
      // Игнорируем ошибки удаления
    }
  }, delaySeconds * 1000);
}

// Функция логирования действий
async function logAction(userId, adminId, action, reason, details = {}) {
  try {
    const log = new Log({
      user_id: userId,
      admin_id: adminId,
      action: action,
      reason: reason,
      details: details
    });
    await log.save();
  } catch (error) {
    console.error('Ошибка логирования:', error);
  }
}

// ==================== КОМАНДЫ БОТА ====================

// Команда start
bot.command('start', async (ctx) => {
  try {
    const isGroup = ctx.chat.type !== 'private';
    
    if (isGroup) {
      const welcomeMsg = await ctx.reply(
        '🤖 **Web3 Guild Bot активирован!**\n\n' +
        '🛡️ Защита от спама и модерация\n' +
        '🎮 Система уровней и баллов\n' +
        '🔐 CAPTCHA для новых участников\n\n' +
        'Используйте /help для списка команд.'
      );
      
      deleteMessageLater(ctx, welcomeMsg.message_id, 60);
    } else {
      await ctx.reply(
        '👋 Привет! Я Web3 Guild Bot.\n\n' +
        '🎯 **Мои функции:**\n' +
        '• Модерация чата\n' +
        '• Система уровней\n' +
        '• Защита от спама\n' +
        '• CAPTCHA проверка\n\n' +
        'Добавьте меня в группу как администратора!'
      );
    }
  } catch (error) {
    console.error('Ошибка команды start:', error);
  }
});

// Команда help
bot.command('help', async (ctx) => {
  try {
    const isAdminUser = await isAdmin(ctx, ctx.from.id);
    
    let helpText = '📋 **Доступные команды:**\n\n' +
      '👤 **Для пользователей:**\n' +
      '/stats - ваша статистика\n' +
      '/top - топ участников\n' +
      '/rules - правила чата\n\n';
    
    if (isAdminUser) {
      helpText += '🛡️ **Для администраторов:**\n' +
        '/warn @user [причина] - предупреждение\n' +
        '/mute @user [время] [причина] - мут\n' +
        '/ban @user [причина] - бан\n' +
        '/unwarn @user - снять предупреждение\n' +
        '/unmute @user - снять мут\n' +
        '/addpoints @user [баллы] - добавить баллы\n' +
        '/setlevel @user [уровень] - установить уровень';
    }
    
    const helpMsg = await ctx.reply(helpText);
    deleteMessageLater(ctx, helpMsg.message_id, 120);
  } catch (error) {
    console.error('Ошибка команды help:', error);
  }
});

// Команда rules
bot.command('rules', async (ctx) => {
  try {
    const rulesMsg = await ctx.reply(
      '📜 **Правила группы:**\n\n' +
      '1. 🚫 Запрещён мат и оскорбления\n' +
      '2. 🔗 Ссылки разрешены через 14 дней после входа\n' +
      '3. 🤖 Новые участники проходят CAPTCHA\n' +
      '4. 💬 Будьте вежливы и конструктивны\n' +
      '5. 📈 Зарабатывайте баллы за активность\n\n' +
      '⚠️ За нарушения выдаются предупреждения\n' +
      '🔇 3 предупреждения = мут на 1 час'
    );
    
    deleteMessageLater(ctx, rulesMsg.message_id, 180);
  } catch (error) {
    console.error('Ошибка команды rules:', error);
  }
});

// Команда stats
bot.command('stats', async (ctx) => {
  try {
    const userId = ctx.from.id;
    const userData = await Promise.race([
      User.findOne({ user_id: userId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 3000))
    ]);
    
    if (!userData) {
      await ctx.reply('❌ Пользователь не найден в базе данных.');
      return;
    }
    
    const levelName = config.levelNames[userData.level] || `Уровень ${userData.level}`;
    const nextLevel = userData.level + 1;
    const nextLevelThreshold = config.levelThresholds.find(t => t.level === nextLevel);
    const pointsToNext = nextLevelThreshold ? nextLevelThreshold.points - userData.points : 0;
    
    const statsText = `📊 **Статистика @${ctx.from.username || ctx.from.first_name}:**\n\n` +
      `⭐ Уровень: ${userData.level} - ${levelName}\n` +
      `💎 Баллы: ${userData.points}\n` +
      `💬 Сообщений: ${userData.messages_count}\n` +
      `⚠️ Предупреждений: ${userData.warnings}/${config.moderation.warningThreshold}\n` +
      `📅 В группе с: ${userData.join_date.toLocaleDateString('ru-RU')}\n` +
      `🕐 Последняя активность: ${userData.last_activity.toLocaleDateString('ru-RU')}\n\n` +
      (pointsToNext > 0 ? `🎯 До следующего уровня: ${pointsToNext} баллов` : '🏆 Максимальный уровень!');
    
    const statsMsg = await ctx.reply(statsText);
    deleteMessageLater(ctx, statsMsg.message_id, 120);
    
  } catch (error) {
    console.error('Ошибка команды stats:', error);
    await ctx.reply('❌ Произошла ошибка при получении статистики.');
  }
});

// Команда top
bot.command('top', async (ctx) => {
  try {
    const topUsers = await Promise.race([
      User.find({ is_banned: false }).sort({ points: -1 }).limit(10),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 3000))
    ]);
    
    if (topUsers.length === 0) {
      await ctx.reply('📊 Пока нет активных пользователей.');
      return;
    }
    
    let topText = '🏆 **Топ-10 участников:**\n\n';
    
    topUsers.forEach((user, index) => {
      const medal = ['🥇', '🥈', '🥉'][index] || `${index + 1}.`;
      const levelName = config.levelNames[user.level] || `Lvl ${user.level}`;
      topText += `${medal} @${user.username || user.first_name} - ${user.points}💎 (${levelName})\n`;
    });
    
    const topMsg = await ctx.reply(topText);
    deleteMessageLater(ctx, topMsg.message_id, 180);
    
  } catch (error) {
    console.error('Ошибка команды top:', error);
    await ctx.reply('❌ Произошла ошибка при получении топа.');
  }
});

// ==================== КОМАНДЫ МОДЕРАЦИИ ====================

// Команда warn
bot.command('warn', async (ctx) => {
  try {
    if (!await isAdmin(ctx, ctx.from.id)) {
      return;
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
      await ctx.reply('❌ Использование: /warn @username [причина]');
      return;
    }
    
    const targetUsername = args[0].replace('@', '');
    const reason = args.slice(1).join(' ') || 'Нарушение правил';
    
    const targetUser = await User.findOne({ username: targetUsername }).maxTimeMS(3000);
    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }
    
    targetUser.warnings += 1;
    setImmediate(() => updateUserPoints(targetUser, config.pointsSettings.spamPenalty, 'Предупреждение'));
    
    if (targetUser.warnings >= config.moderation.warningThreshold) {
      const muteUntil = new Date(Date.now() + config.moderation.muteDurationMinutes * 60 * 1000);
      targetUser.is_muted = true;
      targetUser.mute_until = muteUntil;
      targetUser.warnings = 0;
      
      await ctx.restrictChatMember(targetUser.user_id, {
        permissions: { can_send_messages: false },
        until_date: Math.floor(muteUntil.getTime() / 1000)
      }).catch(() => {});
      
      await ctx.reply(`🔇 @${targetUsername} получил мут на ${config.moderation.muteDurationMinutes} минут за многократные нарушения.`);
      setImmediate(() => logAction(targetUser.user_id, ctx.from.id, 'mute', `Мут за предупреждения: ${reason}`));
    } else {
      const warningsLeft = config.moderation.warningThreshold - targetUser.warnings;
      await ctx.reply(
        `⚠️ @${targetUsername} получил предупреждение за: ${reason}\n` +
        `Предупреждений: ${targetUser.warnings}/${config.moderation.warningThreshold}\n` +
        `До мута осталось: ${warningsLeft}`
      );
      setImmediate(() => logAction(targetUser.user_id, ctx.from.id, 'warning', reason));
    }
    
    setImmediate(async () => {
      try {
        await targetUser.save();
      } catch (error) {
        console.error('Ошибка сохранения предупреждения:', error);
      }
    });
    
  } catch (error) {
    console.error('Ошибка команды warn:', error);
    await ctx.reply('❌ Произошла ошибка при выдаче предупреждения.');
  }
});

// Команда mute
bot.command('mute', async (ctx) => {
  try {
    if (!await isAdmin(ctx, ctx.from.id)) {
      return;
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
      await ctx.reply('❌ Использование: /mute @username [время_в_минутах] [причина]');
      return;
    }
    
    const targetUsername = args[0].replace('@', '');
    const muteDuration = parseInt(args[1]) || config.moderation.muteDurationMinutes;
    const reason = args.slice(2).join(' ') || 'Нарушение правил';
    
    const targetUser = await User.findOne({ username: targetUsername }).maxTimeMS(3000);
    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }
    
    const muteUntil = new Date(Date.now() + muteDuration * 60 * 1000);
    targetUser.is_muted = true;
    targetUser.mute_until = muteUntil;
    
    setImmediate(async () => {
      try {
        await targetUser.save();
      } catch (error) {
        console.error('Ошибка сохранения мута:', error);
      }
    });
    
    await ctx.restrictChatMember(targetUser.user_id, {
      permissions: { can_send_messages: false },
      until_date: Math.floor(muteUntil.getTime() / 1000)
    }).catch(() => {});
    
    await ctx.reply(`🔇 @${targetUsername} получил мут на ${muteDuration} минут. Причина: ${reason}`);
    setImmediate(() => logAction(targetUser.user_id, ctx.from.id, 'mute', reason, { duration: muteDuration }));
    
  } catch (error) {
    console.error('Ошибка команды mute:', error);
    await ctx.reply('❌ Произошла ошибка при выдаче мута.');
  }
});

// Команда unmute
bot.command('unmute', async (ctx) => {
  try {
    if (!await isAdmin(ctx, ctx.from.id)) {
      return;
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
      await ctx.reply('❌ Использование: /unmute @username');
      return;
    }
    
    const targetUsername = args[0].replace('@', '');
    
    const targetUser = await User.findOne({ username: targetUsername }).maxTimeMS(3000);
    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }
    
    targetUser.is_muted = false;
    targetUser.mute_until = null;
    
    setImmediate(async () => {
      try {
        await targetUser.save();
      } catch (error) {
        console.error('Ошибка сохранения размута:', error);
      }
    });
    
    await ctx.restrictChatMember(targetUser.user_id, {
      permissions: {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true
      }
    }).catch(() => {});
    
    await ctx.reply(`🔓 С @${targetUsername} снят мут.`);
    setImmediate(() => logAction(targetUser.user_id, ctx.from.id, 'unmute', 'Мут снят администратором'));
    
  } catch (error) {
    console.error('Ошибка команды unmute:', error);
    await ctx.reply('❌ Произошла ошибка при снятии мута.');
  }
});

// Команда ban
bot.command('ban', async (ctx) => {
  try {
    if (!await isAdmin(ctx, ctx.from.id)) {
      return;
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
      await ctx.reply('❌ Использование: /ban @username [причина]');
      return;
    }
    
    const targetUsername = args[0].replace('@', '');
    const reason = args.slice(1).join(' ') || 'Нарушение правил';
    
    const targetUser = await User.findOne({ username: targetUsername }).maxTimeMS(3000);
    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }
    
    targetUser.is_banned = true;
    
    setImmediate(async () => {
      try {
        await targetUser.save();
      } catch (error) {
        console.error('Ошибка сохранения бана:', error);
      }
    });
    
    await ctx.kickChatMember(targetUser.user_id).catch(() => {});
    
    await ctx.reply(`🚫 @${targetUsername} забанен. Причина: ${reason}`);
    setImmediate(() => logAction(targetUser.user_id, ctx.from.id, 'ban', reason));
    
  } catch (error) {
    console.error('Ошибка команды ban:', error);
    await ctx.reply('❌ Произошла ошибка при бане пользователя.');
  }
});

// Команда unwarn
bot.command('unwarn', async (ctx) => {
  try {
    if (!await isAdmin(ctx, ctx.from.id)) {
      return;
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
      await ctx.reply('❌ Использование: /unwarn @username');
      return;
    }
    
    const targetUsername = args[0].replace('@', '');
    
    const targetUser = await User.findOne({ username: targetUsername }).maxTimeMS(3000);
    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }
    
    if (targetUser.warnings === 0) {
      await ctx.reply('ℹ️ У пользователя нет предупреждений.');
      return;
    }
    
    targetUser.warnings = Math.max(0, targetUser.warnings - 1);
    
    setImmediate(async () => {
      try {
        await targetUser.save();
      } catch (error) {
        console.error('Ошибка сохранения снятия предупреждения:', error);
      }
    });
    
    await ctx.reply(`✅ С @${targetUsername} снято предупреждение. Текущее количество: ${targetUser.warnings}`);
    setImmediate(() => logAction(targetUser.user_id, ctx.from.id, 'unwarn', 'Снято предупреждение'));
    
  } catch (error) {
    console.error('Ошибка команды unwarn:', error);
    await ctx.reply('❌ Произошла ошибка при снятии предупреждения.');
  }
});

// Команда addpoints
bot.command('addpoints', async (ctx) => {
  try {
    if (!await isAdmin(ctx, ctx.from.id)) {
      return;
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
      await ctx.reply('❌ Использование: /addpoints @username [количество]');
      return;
    }
    
    const targetUsername = args[0].replace('@', '');
    const points = parseInt(args[1]);
    
    if (isNaN(points)) {
      await ctx.reply('❌ Количество баллов должно быть числом.');
      return;
    }
    
    const targetUser = await User.findOne({ username: targetUsername }).maxTimeMS(3000);
    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }
    
    setImmediate(() => updateUserPoints(targetUser, points, 'Добавлено администратором'));
    
    await ctx.reply(`✅ @${targetUsername} получил ${points} баллов. Всего: ${targetUser.points + points}`);
    setImmediate(() => logAction(targetUser.user_id, ctx.from.id, 'addpoints', `Добавлено ${points} баллов`));
    
  } catch (error) {
    console.error('Ошибка команды addpoints:', error);
    await ctx.reply('❌ Произошла ошибка при добавлении баллов.');
  }
});

// Команда setlevel
bot.command('setlevel', async (ctx) => {
  try {
    if (!await isAdmin(ctx, ctx.from.id)) {
      return;
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
      await ctx.reply('❌ Использование: /setlevel @username [уровень]');
      return;
    }
    
    const targetUsername = args[0].replace('@', '');
    const level = parseInt(args[1]);
    
    if (isNaN(level) || level < 1 || level > 8) {
      await ctx.reply('❌ Уровень должен быть числом от 1 до 8.');
      return;
    }
    
    const targetUser = await User.findOne({ username: targetUsername }).maxTimeMS(3000);
    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }
    
    targetUser.level = level;
    // Устанавливаем минимальные баллы для этого уровня
    const levelThreshold = config.levelThresholds.find(t => t.level === level);
    if (levelThreshold && targetUser.points < levelThreshold.points) {
      targetUser.points = levelThreshold.points;
    }
    
    setImmediate(async () => {
      try {
        await targetUser.save();
      } catch (error) {
        console.error('Ошибка сохранения уровня:', error);
      }
    });
    
    const levelName = config.levelNames[level] || `Уровень ${level}`;
    await ctx.reply(`✅ @${targetUsername} установлен уровень ${level} - ${levelName}`);
    setImmediate(() => logAction(targetUser.user_id, ctx.from.id, 'setlevel', `Установлен уровень ${level}`));
    
  } catch (error) {
    console.error('Ошибка команды setlevel:', error);
    await ctx.reply('❌ Произошла ошибка при установке уровня.');
  }
});

// Команда getstats (для админов)
bot.command('getstats', async (ctx) => {
  try {
    if (!await isAdmin(ctx, ctx.from.id)) {
      return;
    }
    
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
      await ctx.reply('❌ Использование: /getstats @username');
      return;
    }
    
    const targetUsername = args[0].replace('@', '');
    
    const targetUser = await User.findOne({ username: targetUsername }).maxTimeMS(3000);
    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }
    
    const levelName = config.levelNames[targetUser.level] || `Уровень ${targetUser.level}`;
    const statsText = `📊 **Статистика @${targetUsername}:**\n\n` +
      `🆔 ID: ${targetUser.user_id}\n` +
      `⭐ Уровень: ${targetUser.level} - ${levelName}\n` +
      `💎 Баллы: ${targetUser.points}\n` +
      `💬 Сообщений: ${targetUser.messages_count}\n` +
      `⚠️ Предупреждений: ${targetUser.warnings}\n` +
      `🔇 В муте: ${targetUser.is_muted ? 'Да' : 'Нет'}\n` +
      `🚫 Забанен: ${targetUser.is_banned ? 'Да' : 'Нет'}\n` +
      `✅ Прошёл капчу: ${targetUser.captcha_verified ? 'Да' : 'Нет'}\n` +
      `📅 В группе с: ${targetUser.join_date.toLocaleDateString('ru-RU')}\n` +
      `🕐 Последняя активность: ${targetUser.last_activity.toLocaleDateString('ru-RU')}`;
    
    await ctx.reply(statsText);
    
  } catch (error) {
    console.error('Ошибка команды getstats:', error);
    await ctx.reply('❌ Произошла ошибка при получении статистики.');
  }
});

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error('Ошибка бота:', err);
});

// Запуск бота
bot.launch()
  .then(() => {
    console.log('🚀 Web3 Guild Bot запущен! (Исправленная версия)');
    console.log('📊 Модерация: ✅ Активна');
    console.log('🎮 Геймификация: ✅ Активна');
    console.log('🔐 CAPTCHA: ✅ При первом сообщении');
    console.log('🔗 Ограничение ссылок: ✅ 14 дней для новых');
    console.log('⚡ Оптимизация: ✅ Улучшена производительность');
  })
  .catch(err => {
    console.error('❌ Ошибка запуска бота:', err);
    process.exit(1);
  });

// Обработка завершения процесса
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));