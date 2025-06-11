const express = require('express');
const mongoose = require('mongoose');
const config = require('./config');
require('dotenv').config();

const app = express();
const PORT = process.env.ADMIN_PORT || 3000;

// Подключение к MongoDB с улучшенными настройками
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/web3_guild_bot', {
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  bufferCommands: false,
  bufferMaxEntries: 0
})
  .then(() => console.log('✅ Админ-панель подключена к MongoDB'))
  .catch(err => console.error('❌ Ошибка подключения к MongoDB:', err));

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Добавляем timeout для всех запросов
app.use((req, res, next) => {
  req.setTimeout(10000); // 10 секунд
  res.setTimeout(10000);
  next();
});

// Получаем модели из основного бота
const User = mongoose.model('User');
const Log = mongoose.model('Log');

// Простая HTML страница админ-панели
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Web3 Guild Bot - Админ панель</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background-color: #1a1a1a;
            color: #fff;
            margin: 0;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 {
            text-align: center;
            color: #4CAF50;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin: 30px 0;
        }
        .stat-card {
            background: #2a2a2a;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
            border: 1px solid #333;
        }
        .stat-card h3 {
            margin: 0 0 10px 0;
            color: #4CAF50;
        }
        .stat-card .value {
            font-size: 2em;
            font-weight: bold;
        }
        .loading {
            color: #ff9800;
        }
        .error {
            color: #f44336;
        }
        table {
            width: 100%;
            background: #2a2a2a;
            border-radius: 10px;
            overflow: hidden;
            margin: 20px 0;
        }
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #333;
        }
        th {
            background: #333;
            color: #4CAF50;
        }
        .level {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.8em;
            background: #4CAF50;
            color: #fff;
        }
        .warning {
            color: #ff9800;
        }
        .muted {
            color: #f44336;
        }
        .search-box {
            width: 100%;
            padding: 10px;
            margin: 20px 0;
            background: #2a2a2a;
            border: 1px solid #333;
            color: #fff;
            border-radius: 5px;
            font-size: 16px;
        }
        .logs {
            max-height: 400px;
            overflow-y: auto;
            background: #2a2a2a;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        .log-entry {
            padding: 10px;
            margin: 5px 0;
            background: #1a1a1a;
            border-radius: 5px;
            border-left: 3px solid #4CAF50;
        }
        .refresh-btn {
            background: #4CAF50;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
            margin-right: 10px;
        }
        .refresh-btn:hover {
            background: #45a049;
        }
        .refresh-btn:disabled {
            background: #666;
            cursor: not-allowed;
        }
        .status {
            padding: 10px;
            margin: 10px 0;
            border-radius: 5px;
            text-align: center;
        }
        .status.success {
            background: #4CAF50;
        }
        .status.error {
            background: #f44336;
        }
        .status.warning {
            background: #ff9800;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 Web3 Guild Bot - Панель управления</h1>
        
        <div id="status" class="status" style="display: none;"></div>
        
        <button class="refresh-btn" onclick="refreshAll()" id="refreshBtn">🔄 Обновить данные</button>
        <button class="refresh-btn" onclick="clearCache()">🗑️ Очистить кеш</button>
        
        <div class="stats-grid" id="stats">
            <div class="stat-card">
                <h3>👥 Всего пользователей</h3>
                <div class="value loading" id="totalUsers">Загрузка...</div>
            </div>
            <div class="stat-card">
                <h3>✅ Активных сегодня</h3>
                <div class="value loading" id="activeToday">Загрузка...</div>
            </div>
            <div class="stat-card">
                <h3>🔇 В муте</h3>
                <div class="value loading" id="mutedUsers">Загрузка...</div>
            </div>
            <div class="stat-card">
                <h3>🚫 Забанено</h3>
                <div class="value loading" id="bannedUsers">Загрузка...</div>
            </div>
        </div>

        <h2>🔍 Поиск пользователей</h2>
        <input type="text" class="search-box" id="searchBox" placeholder="Введите имя пользователя..." onkeyup="debounceSearch()">

        <h2>📊 Топ-10 активных пользователей</h2>
        <table>
            <thead>
                <tr>
                    <th>Пользователь</th>
                    <th>Уровень</th>
                    <th>Баллы</th>
                    <th>Сообщений</th>
                    <th>Предупреждения</th>
                    <th>Статус</th>
                </tr>
            </thead>
            <tbody id="topUsers">
                <tr><td colspan="6" class="loading">Загрузка...</td></tr>
            </tbody>
        </table>

        <h2>📋 Последние действия модерации</h2>
        <div class="logs" id="moderationLogs">
            <div class="log-entry loading">Загрузка логов...</div>
        </div>
    </div>

    <script>
        // Переменные для управления состоянием
        let isLoading = false;
        let searchTimeout;
        let lastSearchQuery = '';
        
        // Показать статус
        function showStatus(message, type = 'success') {
            const statusDiv = document.getElementById('status');
            statusDiv.textContent = message;
            statusDiv.className = \`status \${type}\`;
            statusDiv.style.display = 'block';
            
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 3000);
        }
        
        // Безопасный fetch с timeout
        async function safeFetch(url, timeout = 5000) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            
            try {
                const response = await fetch(url, {
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
                }
                
                return await response.json();
            } catch (error) {
                clearTimeout(timeoutId);
                if (error.name === 'AbortError') {
                    throw new Error('Запрос превысил время ожидания');
                }
                throw error;
            }
        }

        // Загрузка статистики
        async function loadStats() {
            try {
                const data = await safeFetch('/api/stats');
                
                document.getElementById('totalUsers').textContent = data.totalUsers || 0;
                document.getElementById('totalUsers').className = 'value';
                
                document.getElementById('activeToday').textContent = data.activeToday || 0;
                document.getElementById('activeToday').className = 'value';
                
                document.getElementById('mutedUsers').textContent = data.mutedUsers || 0;
                document.getElementById('mutedUsers').className = 'value';
                
                document.getElementById('bannedUsers').textContent = data.bannedUsers || 0;
                document.getElementById('bannedUsers').className = 'value';
                
            } catch (error) {
                console.error('Ошибка загрузки статистики:', error);
                showStatus('Ошибка загрузки статистики: ' + error.message, 'error');
                
                // Показываем ошибку в карточках
                ['totalUsers', 'activeToday', 'mutedUsers', 'bannedUsers'].forEach(id => {
                    const element = document.getElementById(id);
                    element.textContent = 'Ошибка';
                    element.className = 'value error';
                });
            }
        }

        // Загрузка топ пользователей
        async function loadTopUsers() {
            try {
                const users = await safeFetch('/api/top-users');
                
                const tbody = document.getElementById('topUsers');
                
                if (users.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6">Нет данных</td></tr>';
                    return;
                }
                
                tbody.innerHTML = users.map(user => \`
                    <tr>
                        <td>@\${user.username || user.first_name || 'Без имени'}</td>
                        <td><span class="level">\${user.levelName || 'Неизвестно'}</span></td>
                        <td>\${user.points || 0}</td>
                        <td>\${user.messages_count || 0}</td>
                        <td class="\${user.warnings > 0 ? 'warning' : ''}">\${user.warnings || 0}</td>
                        <td class="\${user.is_muted ? 'muted' : ''}">\${user.is_muted ? '🔇 Мут' : '✅ Активен'}</td>
                    </tr>
                \`).join('');
            } catch (error) {
                console.error('Ошибка загрузки топа:', error);
                showStatus('Ошибка загрузки топа пользователей: ' + error.message, 'error');
                
                const tbody = document.getElementById('topUsers');
                tbody.innerHTML = '<tr><td colspan="6" class="error">Ошибка загрузки данных</td></tr>';
            }
        }

        // Загрузка логов
        async function loadLogs() {
            try {
                const logs = await safeFetch('/api/logs');
                
                const logsDiv = document.getElementById('moderationLogs');
                
                if (logs.length === 0) {
                    logsDiv.innerHTML = '<div class="log-entry">Нет логов</div>';
                    return;
                }
                
                logsDiv.innerHTML = logs.map(log => \`
                    <div class="log-entry">
                        <strong>\${new Date(log.timestamp).toLocaleString('ru-RU')}</strong><br>
                        Действие: <strong>\${log.action || 'Неизвестно'}</strong><br>
                        Пользователь ID: \${log.user_id || 'Неизвестно'}<br>
                        Админ ID: \${log.admin_id || 'Неизвестно'}<br>
                        Причина: \${log.reason || 'Не указана'}
                    </div>
                \`).join('');
            } catch (error) {
                console.error('Ошибка загрузки логов:', error);
                showStatus('Ошибка загрузки логов: ' + error.message, 'error');
                
                const logsDiv = document.getElementById('moderationLogs');
                logsDiv.innerHTML = '<div class="log-entry error">Ошибка загрузки логов</div>';
            }
        }

        // Поиск пользователей с debounce
        function debounceSearch() {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(searchUsers, 500); // 500ms задержка
        }

        // Поиск пользователей
        async function searchUsers() {
            const query = document.getElementById('searchBox').value.trim();
            
            if (query.length < 2) {
                if (lastSearchQuery !== '') {
                    lastSearchQuery = '';
                    loadTopUsers(); // Возвращаем топ пользователей
                }
                return;
            }
            
            if (query === lastSearchQuery) {
                return; // Избегаем повторных запросов
            }
            
            lastSearchQuery = query;
            
            try {
                const users = await safeFetch(\`/api/search?q=\${encodeURIComponent(query)}\`);
                
                // Обновляем таблицу результатами поиска
                const tbody = document.getElementById('topUsers');
                
                if (users.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6">Пользователи не найдены</td></tr>';
                    return;
                }
                
                tbody.innerHTML = users.map(user => \`
                    <tr>
                        <td>@\${user.username || user.first_name || 'Без имени'}</td>
                        <td><span class="level">\${user.levelName || 'Неизвестно'}</span></td>
                        <td>\${user.points || 0}</td>
                        <td>\${user.messages_count || 0}</td>
                        <td class="\${user.warnings > 0 ? 'warning' : ''}">\${user.warnings || 0}</td>
                        <td class="\${user.is_muted ? 'muted' : ''}">\${user.is_muted ? '🔇 Мут' : '✅ Активен'}</td>
                    </tr>
                \`).join('');
            } catch (error) {
                console.error('Ошибка поиска:', error);
                showStatus('Ошибка поиска: ' + error.message, 'error');
            }
        }
        
        // Обновить все данные
        async function refreshAll() {
            if (isLoading) return;
            
            isLoading = true;
            const refreshBtn = document.getElementById('refreshBtn');
            refreshBtn.disabled = true;
            refreshBtn.textContent = '⏳ Обновление...';
            
            try {
                await Promise.all([
                    loadStats(),
                    loadTopUsers(),
                    loadLogs()
                ]);
                
                showStatus('Данные успешно обновлены!', 'success');
            } catch (error) {
                showStatus('Ошибка при обновлении данных', 'error');
            } finally {
                isLoading = false;
                refreshBtn.disabled = false;
                refreshBtn.textContent = '🔄 Обновить данные';
            }
        }
        
        // Очистить кеш
        function clearCache() {
            if ('caches' in window) {
                caches.keys().then(function(names) {
                    for (let name of names) {
                        caches.delete(name);
                    }
                });
            }
            
            // Очищаем локальные переменные
            lastSearchQuery = '';
            document.getElementById('searchBox').value = '';
            
            showStatus('Кеш очищен', 'success');
            refreshAll();
        }

        // Загружаем данные при загрузке страницы
        window.onload = () => {
            refreshAll();
            
            // Автообновление каждые 30 секунд (только если страница активна)
            setInterval(() => {
                if (!document.hidden && !isLoading) {
                    refreshAll();
                }
            }, 30000);
        };
        
        // Обработка видимости страницы
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && !isLoading) {
                // Страница стала видимой - обновляем данные
                refreshAll();
            }
        });
    </script>
</body>
</html>
  `);
});

// API endpoints с улучшенной обработкой ошибок
app.get('/api/stats', async (req, res) => {
  try {
    const timeout = 5000; // 5 секунд
    
    const [totalUsers, activeToday, mutedUsers, bannedUsers] = await Promise.all([
      Promise.race([
        User.countDocuments().exec(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
      ]),
      Promise.race([
        (() => {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          return User.countDocuments({ last_activity: { $gte: today } }).exec();
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
      ]),
      Promise.race([
        User.countDocuments({ is_muted: true }).exec(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
      ]),
      Promise.race([
        User.countDocuments({ is_banned: true }).exec(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
      ])
    ]);
    
    res.json({
      totalUsers: totalUsers || 0,
      activeToday: activeToday || 0,
      mutedUsers: mutedUsers || 0,
      bannedUsers: bannedUsers || 0
    });
  } catch (error) {
    console.error('Ошибка API stats:', error);
    res.status(500).json({ 
      error: error.message,
      totalUsers: 0,
      activeToday: 0,
      mutedUsers: 0,
      bannedUsers: 0
    });
  }
});

app.get('/api/top-users', async (req, res) => {
  try {
    const users = await Promise.race([
      User.find({ is_banned: false })
        .sort({ points: -1 })
        .limit(10)
        .lean()
        .exec(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
    
    const usersWithLevels = users.map(user => ({
      ...user,
      levelName: config.levelNames[user.level] || `Уровень ${user.level}`
    }));
    
    res.json(usersWithLevels);
  } catch (error) {
    console.error('Ошибка API top-users:', error);
    res.status(500).json([]);
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const logs = await Promise.race([
      Log.find()
        .sort({ timestamp: -1 })
        .limit(20)
        .lean()
        .exec(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
    
    res.json(logs);
  } catch (error) {
    console.error('Ошибка API logs:', error);
    res.status(500).json([]);
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    
    if (!query || query.length < 2) {
      return res.json([]);
    }
    
    const users = await Promise.race([
      User.find({
        $or: [
          { username: new RegExp(query, 'i') },
          { first_name: new RegExp(query, 'i') }
        ]
      })
      .limit(10)
      .lean()
      .exec(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
    
    const usersWithLevels = users.map(user => ({
      ...user,
      levelName: config.levelNames[user.level] || `Уровень ${user.level}`
    }));
    
    res.json(usersWithLevels);
  } catch (error) {
    console.error('Ошибка API search:', error);
    res.status(500).json([]);
  }
});

// Обработка глобальных ошибок
app.use((err, req, res, next) => {
  console.error('Глобальная ошибка:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// Обработка 404
app.use((req, res) => {
  res.status(404).json({ error: 'Страница не найдена' });
});

// Запуск сервера
const server = app.listen(PORT, () => {
  console.log(`🌐 Админ-панель запущена на http://localhost:${PORT}`);
  console.log(`⚡ Оптимизированная версия с улучшенной обработкой ошибок`);
});

// Обработка завершения
process.on('SIGINT', () => {
  console.log('🛑 Получен сигнал SIGINT. Закрытие сервера...');
  server.close(() => {
    console.log('✅ Сервер закрыт');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('🛑 Получен сигнал SIGTERM. Закрытие сервера...');
  server.close(() => {
    console.log('✅ Сервер закрыт');
    process.exit(0);
  });
});