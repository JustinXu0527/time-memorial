const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');

// 数据目录
const userDataPath = app.getPath('userData');
const dataPath = path.join(userDataPath, 'data');
const photosPath = path.join(dataPath, 'photos');
const videosPath = path.join(dataPath, 'videos');

// 确保数据目录存在
function ensureDirs() {
  if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });
  if (!fs.existsSync(photosPath)) fs.mkdirSync(photosPath, { recursive: true });
  if (!fs.existsSync(videosPath)) fs.mkdirSync(videosPath, { recursive: true });
}

// 读取 JSON 文件
function readJSON(filename, defaultValue) {
  const filePath = path.join(dataPath, filename);
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('读取文件失败:', filename, e);
  }
  return defaultValue;
}

// 写入 JSON 文件
function writeJSON(filename, data) {
  const filePath = path.join(dataPath, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('写入文件失败:', filename, e);
    return false;
  }
}

// SHA-256 加密
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// 创建主窗口
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    frame: true,
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/pages/login.html'));
  
  // 开发环境打开调试工具
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  ensureDirs();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ==================== IPC 通信 ====================

// 检查是否已设置密码
ipcMain.handle('check-has-password', () => {
  const settings = readJSON('settings.json', {});
  return { hasPassword: !!settings.passwordHash };
});

// 设置密码（首次）
ipcMain.handle('set-password', (event, password) => {
  const settings = readJSON('settings.json', {});
  settings.passwordHash = sha256(password);
  const success = writeJSON('settings.json', settings);
  return { success };
});

// 验证密码
ipcMain.handle('verify-password', (event, password) => {
  const settings = readJSON('settings.json', {});
  const hash = sha256(password);
  return { success: hash === settings.passwordHash };
});

// 获取设置
ipcMain.handle('get-settings', () => {
  const settings = readJSON('settings.json', {
    meetDate: '',
    breakupRecords: [],
    birthday: '',
    theme: 'sweet-pink',
    customBg: ''
  });
  delete settings.passwordHash;
  // 兼容旧版 status + breakupDate 自动迁移
  if (!settings.breakupRecords && settings.breakupDate) {
    settings.breakupRecords = [{ id: 1, breakupDate: settings.breakupDate, reunionDate: '' }];
  }
  if (!settings.breakupRecords) settings.breakupRecords = [];
  return settings;
});

// 保存设置
ipcMain.handle('save-settings', (event, settings) => {
  const current = readJSON('settings.json', {});
  const newSettings = { ...current, ...settings };
  // 清理旧字段
  delete newSettings.status;
  delete newSettings.breakupDate;
  const success = writeJSON('settings.json', newSettings);
  delete newSettings.passwordHash;
  return { success, settings: newSettings };
});

// 获取总计时统计（前端每秒轮询用）
ipcMain.handle('get-total-times', (event, meetDate, breakupRecords) => {
  let togetherSeconds = 0;
  let apartSeconds = 0;
  const now = new Date();

  if (!meetDate) {
    return { togetherSeconds: 0, apartSeconds: 0, status: 'unknown' };
  }

  const meetTime = new Date(meetDate.replace(' ', 'T'));
  const sortedRecords = [...(breakupRecords || [])]
    .filter(r => r.breakupDate)
    .sort((a, b) => new Date(a.breakupDate.replace(' ', 'T')) - new Date(b.breakupDate.replace(' ', 'T')));

  let currentStatus = 'together';
  let lastPoint = meetTime;

  sortedRecords.forEach((record, idx) => {
    const breakupTime = new Date(record.breakupDate.replace(' ', 'T'));
    const reunionTime = record.reunionDate ? new Date(record.reunionDate.replace(' ', 'T')) : null;

    if (breakupTime > lastPoint) {
      togetherSeconds += Math.floor((breakupTime - lastPoint) / 1000);
    }

    if (reunionTime && reunionTime > breakupTime) {
      apartSeconds += Math.floor((reunionTime - breakupTime) / 1000);
      lastPoint = reunionTime;
      if (idx === sortedRecords.length - 1) currentStatus = 'together';
    } else {
      apartSeconds += Math.floor((now - breakupTime) / 1000);
      lastPoint = now;
      currentStatus = 'breakup';
    }
  });

  if (currentStatus === 'together' && lastPoint < now) {
    togetherSeconds += Math.floor((now - lastPoint) / 1000);
  }

  return { togetherSeconds, apartSeconds, status: currentStatus };
});

// 获取所有日记
ipcMain.handle('get-diaries', () => {
  return readJSON('diaries.json', []);
});

// 保存日记（新增或更新）
ipcMain.handle('save-diary', (event, diary) => {
  const diaries = readJSON('diaries.json', []);
  // 统一在后端重新计算字数，避免数据不一致
  diary.wordCount = diary.content ? diary.content.replace(/\s/g, '').length : 0;
  if (diary.id) {
    // 更新
    const index = diaries.findIndex(d => d.id === diary.id);
    if (index !== -1) {
      diaries[index] = { ...diaries[index], ...diary, updatedAt: new Date().toISOString() };
    }
  } else {
    // 新增
    diary.id = Date.now();
    diary.createdAt = new Date().toISOString();
    diaries.push(diary);
  }
  const success = writeJSON('diaries.json', diaries);
  return { success, diary };
});

// 删除日记
ipcMain.handle('delete-diary', (event, id) => {
  let diaries = readJSON('diaries.json', []);
  diaries = diaries.filter(d => d.id !== id);
  const success = writeJSON('diaries.json', diaries);
  return { success };
});

// 获取日记统计
ipcMain.handle('get-diary-stats', () => {
  const diaries = readJSON('diaries.json', []);
  const totalWords = diaries.reduce((sum, d) => sum + (d.wordCount || 0), 0);
  const totalCount = diaries.length;
  
  // 按月统计
  const monthStats = {};
  diaries.forEach(d => {
    const month = d.date ? d.date.substring(0, 7) : 'unknown';
    monthStats[month] = (monthStats[month] || 0) + 1;
  });
  
  // 心情统计（支持多选心情数组）
  const moodStats = {};
  diaries.forEach(d => {
    const moods = Array.isArray(d.moods) ? d.moods : (d.mood ? [d.mood] : ['normal']);
    moods.forEach(m => {
      moodStats[m] = (moodStats[m] || 0) + 1;
    });
  });
  
  return {
    totalWords,
    totalCount,
    monthStats,
    moodStats
  };
});

// 获取相册分类
ipcMain.handle('get-albums', () => {
  return readJSON('albums.json', [
    { id: 'daily', name: '日常', count: 0 },
    { id: 'travel', name: '旅行', count: 0 },
    { id: 'anniversary', name: '纪念日', count: 0 }
  ]);
});

// 保存相册分类
ipcMain.handle('save-album', (event, album) => {
  let albums = readJSON('albums.json', []);
  if (album.id) {
    const index = albums.findIndex(a => a.id === album.id);
    if (index !== -1) albums[index] = { ...albums[index], ...album };
  } else {
    album.id = 'album_' + Date.now();
    album.count = 0;
    albums.push(album);
  }
  const success = writeJSON('albums.json', albums);
  return { success, album };
});

// 获取照片列表
ipcMain.handle('get-photos', (event, albumId) => {
  const photos = readJSON('photos.json', []);
  if (albumId && albumId !== 'all') {
    return photos.filter(p => p.albumId === albumId);
  }
  return photos;
});

// 上传照片
ipcMain.handle('upload-photo', async (event, { filePath, albumId, note }) => {
  try {
    const photos = readJSON('photos.json', []);
    const ext = path.extname(filePath);
    const filename = Date.now() + '_' + Math.random().toString(36).substr(2, 6) + ext;
    const destPath = path.join(photosPath, filename);
    
    fs.copyFileSync(filePath, destPath);
    
    const photo = {
      id: Date.now(),
      filename,
      albumId: albumId || 'daily',
      note: note || '',
      type: 'photo',
      uploadedAt: new Date().toISOString()
    };
    photos.push(photo);
    writeJSON('photos.json', photos);
    
    return { success: true, photo };
  } catch (e) {
    console.error('上传照片失败:', e);
    return { success: false, error: e.message };
  }
});

// ==================== 聊天记录 ====================

// 获取所有聊天记录
ipcMain.handle('get-chats', (event, platform) => {
  const chats = readJSON('chats.json', []);
  if (platform && platform !== 'all') {
    return chats.filter(c => c.platform === platform);
  }
  return chats;
});

// 获取聊天统计
ipcMain.handle('get-chat-stats', () => {
  const chats = readJSON('chats.json', []);
  const platformStats = {};
  chats.forEach(c => {
    platformStats[c.platform] = (platformStats[c.platform] || 0) + 1;
  });
  return {
    totalChats: chats.length,
    totalMessages: chats.reduce((sum, c) => sum + (c.messages ? c.messages.length : 0), 0),
    platformStats
  };
});

// 保存聊天记录
ipcMain.handle('save-chat', (event, chat) => {
  const chats = readJSON('chats.json', []);
  if (chat.id) {
    const index = chats.findIndex(c => c.id === chat.id);
    if (index !== -1) {
      chats[index] = { ...chats[index], ...chat, updatedAt: new Date().toISOString() };
    }
  } else {
    chat.id = Date.now();
    chat.createdAt = new Date().toISOString();
    chats.push(chat);
  }
  writeJSON('chats.json', chats);
  return { success: true, chat };
});

// 删除聊天记录
ipcMain.handle('delete-chat', (event, id) => {
  let chats = readJSON('chats.json', []);
  chats = chats.filter(c => c.id !== id);
  writeJSON('chats.json', chats);
  return { success: true };
});

// 导入聊天文件
ipcMain.handle('import-chat-file', async (event, { filePath, platform, contactName }) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    let messages = [];

    if (ext === '.txt') {
      const text = fs.readFileSync(filePath, 'utf-8');
      messages = parseTxtChat(text);
    } else if (ext === '.csv') {
      const text = fs.readFileSync(filePath, 'utf-8');
      messages = parseCsvChat(text);
    } else if (ext === '.json') {
      const text = fs.readFileSync(filePath, 'utf-8');
      messages = parseJsonChat(text);
    } else if (ext === '.html' || ext === '.htm') {
      const text = fs.readFileSync(filePath, 'utf-8');
      messages = parseHtmlChat(text);
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      messages = parseTxtChat(result.value);
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      messages = parseExcelChat(data);
    } else {
      return { success: false, error: '不支持的文件格式：' + ext };
    }

    if (messages.length === 0) {
      return { success: false, error: '未能从文件中解析出聊天记录，请检查文件格式' };
    }

    const chat = {
      id: Date.now(),
      platform: platform || 'other',
      contactName: contactName || fileName,
      messages: messages,
      messageCount: messages.length,
      sourceFile: fileName,
      importedAt: new Date().toISOString()
    };

    const chats = readJSON('chats.json', []);
    chats.push(chat);
    writeJSON('chats.json', chats);

    return { success: true, chat };
  } catch (e) {
    console.error('导入聊天文件失败:', e);
    return { success: false, error: e.message };
  }
});

// TXT 解析：支持多种常见格式
function parseTxtChat(text) {
  const messages = [];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  
  // 尝试匹配时间格式的行: 2024-01-01 12:00 张三: 你好
  const timePattern = /^(\d{2,4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+([^:]+)[:：]\s*(.+)$/;
  // 微信导出格式: 张三 2024-01-01 12:00
  const wechatPattern = /^([^\s]+)\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)$/;
  // 简单格式: 张三: 你好
  const simplePattern = /^([^:：]{1,20})[:：]\s*(.+)$/;

  let pendingSender = null;
  let pendingTime = null;
  let pendingContent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const timeMatch = line.match(timePattern);
    const wechatMatch = line.match(wechatPattern);
    
    if (timeMatch) {
      // 如果之前有暂存的消息，先推入
      if (pendingSender && pendingContent) {
        messages.push({ id: messages.length + 1, sender: 'other', senderName: pendingSender, content: pendingContent.trim(), time: pendingTime || '' });
        pendingContent = '';
      }
      messages.push({
        id: messages.length + 1,
        sender: 'other',
        senderName: timeMatch[2].trim(),
        content: timeMatch[3].trim(),
        time: timeMatch[1]
      });
      pendingSender = null;
    } else if (wechatMatch && i + 1 < lines.length) {
      if (pendingSender && pendingContent) {
        messages.push({ id: messages.length + 1, sender: 'other', senderName: pendingSender, content: pendingContent.trim(), time: pendingTime || '' });
      }
      pendingSender = wechatMatch[1];
      pendingTime = wechatMatch[2];
      pendingContent = lines[i + 1] || '';
      i++;
    } else {
      const simpleMatch = line.match(simplePattern);
      if (simpleMatch) {
        if (pendingSender && pendingContent) {
          messages.push({ id: messages.length + 1, sender: 'other', senderName: pendingSender, content: pendingContent.trim(), time: pendingTime || '' });
        }
        messages.push({
          id: messages.length + 1,
          sender: 'other',
          senderName: simpleMatch[1].trim(),
          content: simpleMatch[2].trim(),
          time: ''
        });
        pendingSender = null;
        pendingContent = '';
      } else if (pendingSender) {
        // 多行消息续行
        pendingContent += '\n' + line;
      } else {
        // 纯文本行
        messages.push({
          id: messages.length + 1,
          sender: 'other',
          senderName: '',
          content: line.trim(),
          time: ''
        });
      }
    }
  }

  // 处理最后一条暂存消息
  if (pendingSender && pendingContent) {
    messages.push({ id: messages.length + 1, sender: 'other', senderName: pendingSender, content: pendingContent.trim(), time: pendingTime || '' });
  }

  return messages;
}

// CSV 解析
function parseCsvChat(text) {
  const messages = [];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return messages;

  const header = lines[0].toLowerCase();
  const hasTime = header.includes('time') || header.includes('时间') || header.includes('日期');
  const hasSender = header.includes('sender') || header.includes('发送者') || header.includes('发送人') || header.includes('name') || header.includes('姓名');
  const hasContent = header.includes('content') || header.includes('内容') || header.includes('message') || header.includes('消息') || header.includes('text');

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length === 0) continue;
    const msg = {
      id: messages.length + 1,
      sender: 'other',
      senderName: hasSender && cols.length > 1 ? (cols[1] || '').trim() : '',
      content: (hasContent ? (cols[2] || cols[cols.length - 1]) : (cols[cols.length - 1] || cols[0]) || '').trim(),
      time: hasTime ? (cols[0] || '').trim() : ''
    };
    if (msg.content) messages.push(msg);
  }
  return messages;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

// JSON 解析
function parseJsonChat(text) {
  const messages = [];
  try {
    let data = JSON.parse(text);
    let selfUid = '';

    // 识别自己的 uid（用于判断消息发送方）
    if (data.chatInfo && data.chatInfo.selfUid) {
      selfUid = data.chatInfo.selfUid;
    } else if (data.chatInfo && data.chatInfo.selfUin) {
      selfUid = data.chatInfo.selfUin;
    }

    if (!Array.isArray(data)) {
      // 尝试找 messages 字段
      if (data.messages && Array.isArray(data.messages)) data = data.messages;
      else if (data.data && Array.isArray(data.data)) data = data.data;
      else return messages;
    }
    data.forEach((item, idx) => {
      if (typeof item === 'string') {
        messages.push({ id: idx + 1, sender: 'other', senderName: '', content: item, time: '' });
      } else if (typeof item === 'object') {
        // 判断发送方：自己发的还是对方发的
        let sender = 'other';
        if (item.isMe) sender = 'me';
        else if (item.sender === 'me') sender = 'me';
        else if (selfUid && item.sender && typeof item.sender === 'object') {
          // QQ 聊天导出格式：sender 是对象 { uid, name }
          if (item.sender.uid === selfUid) sender = 'me';
        }

        // 提取发送者名称
        let senderName = '';
        if (item.senderName && typeof item.senderName === 'string') {
          senderName = item.senderName.trim();
        } else if (item.name && typeof item.name === 'string') {
          senderName = item.name.trim();
        } else if (item.sender && typeof item.sender === 'object' && item.sender.name) {
          // QQ 格式：sender.name
          senderName = String(item.sender.name || '').trim();
        } else if (item.sender && typeof item.sender === 'string') {
          senderName = item.sender.trim();
        }

        // 提取消息内容
        let content = '';
        if (item.content && typeof item.content === 'object') {
          // QQ 格式：content.text
          content = String(item.content.text || '');
        } else if (item.content && typeof item.content === 'string') {
          content = item.content;
        } else if (item.message && typeof item.message === 'string') {
          content = item.message;
        } else if (item.text && typeof item.text === 'string') {
          content = item.text;
        }
        content = content.trim();

        // 如果 content 包含 [图片:xxx] 格式，替换为更友好的显示
        if (content.match(/^\[图片:/)) {
          content = '[图片]';
        } else if (content.match(/^\[视频:/)) {
          content = '[视频]';
        } else if (content.match(/^\[文件:/)) {
          content = '[文件]';
        }

        // 跳过系统消息（type === 'system' 或 sender 名称为"系统消息"）
        if (item.type === 'system' || item.system === true) {
          // 系统消息跳过不显示
          return;
        }

        // 提取时间
        let time = '';
        if (item.time && typeof item.time === 'string') {
          time = item.time.trim();
        } else if (item.date && typeof item.date === 'string') {
          time = item.date.trim();
        } else if (item.timestamp) {
          time = String(item.timestamp).trim();
        }

        // 跳过空内容
        if (!content && (item.type !== 'text' || item.elements)) return;

        messages.push({
          id: idx + 1,
          sender: sender,
          senderName: senderName,
          content: content,
          time: time
        });
      }
    });
  } catch (e) { /* ignore */ }
  return messages;
}

// HTML 解析：支持 QQ 聊天记录导出的 HTML 格式（优先提取 JSON 数据）
function parseHtmlChat(text) {
  const messages = [];

  // 1. 尝试从 QQ 聊天记录导出 HTML 中提取 JSON 数据
  // QQ 导出格式：window.__QCE_CHUNK__({id:"xxx",messages:[...]})
  const qqChunkPattern = /window\.__QCE_CHUNK__\((\{[\s\S]*?\})\)[\s;]*$/gm;
  let qqMatch;
  const allMessages = [];

  while ((qqMatch = qqChunkPattern.exec(text)) !== null) {
    try {
      const chunkData = JSON.parse(qqMatch[1]);
      if (chunkData.messages && Array.isArray(chunkData.messages)) {
        allMessages.push(...chunkData.messages);
      }
    } catch (e) {
      // JSON 解析失败，跳过当前 chunk
    }
  }

  if (allMessages.length > 0) {
    // 按时间戳排序
    allMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));

    // 确定自己的 uid：频繁出现且 name 为 "我" 或查看 self 消息数量最多的 uid
    const uidCount = {};
    const selfUidCount = {};
    allMessages.forEach(msg => {
      if (msg.uid && msg.uid !== '未知') {
        uidCount[msg.uid] = (uidCount[msg.uid] || 0) + 1;
      }
      if (msg.html) {
        // 通过 HTML 中的 message self/other 类判断
        if (msg.html.includes('"message self"') || msg.html.includes("'message self'")) {
          selfUidCount[msg.uid] = (selfUidCount[msg.uid] || 0) + 1;
        }
      }
    });

    // 找出自己消息最多的 uid
    let selfUid = '';
    let maxSelf = 0;
    Object.entries(selfUidCount).forEach(([uid, count]) => {
      if (count > maxSelf) {
        maxSelf = count;
        selfUid = uid;
      }
    });

    // 如果 HTML 中没有明确标识，通过 name 判断（name 为特殊字符或较短的可能是我自己）
    if (!selfUid) {
      Object.entries(uidCount).forEach(([uid, count]) => {
        const nameMsgs = allMessages.filter(m => m.uid === uid && m.name);
        const name = nameMsgs.length > 0 ? nameMsgs[0].name : '';
        // QQ 导出中，用户自己的名字可能是特殊字符或较短的标识
        if (name && name.length <= 2 && count > maxSelf) {
          maxSelf = count;
          selfUid = uid;
        }
      });
    }

    allMessages.forEach((msg, idx) => {
      // 跳过系统消息
      if (msg.name === '系统消息' || msg.uid === '未知') {
        return;
      }

      // 判断发送方
      let sender = 'other';
      if (selfUid && msg.uid === selfUid) {
        sender = 'me';
      } else if (msg.html) {
        if (msg.html.includes('"message self"') || msg.html.includes("'message self'")) {
          sender = 'me';
        }
      }

      // 提取文本内容
      let content = msg.text || '';
      content = content.trim();

      // 处理 QQ 表情：将 /斜眼笑 等替换为空或保留文本形式
      // 图片、贴纸消息（text 以 [图片: 或 [视频: 或 [文件: 开头）
      if (content.match(/^\[图片:/) || content.match(/^\[表情:/) || content.match(/^\[贴纸:/)) {
        content = '[图片]';
      } else if (content.match(/^\[视频:/)) {
        content = '[视频]';
      } else if (content.match(/^\[文件:/)) {
        content = '[文件]';
      } else if (content.match(/^\[语音:/)) {
        content = '[语音]';
      }

      // 跳过空内容
      if (!content) return;

      // 格式化时间
      let time = '';
      if (msg.ts) {
        const d = new Date(msg.ts);
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const h = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        time = `${y}-${mo}-${day} ${h}:${mi}:${s}`;
      }

      messages.push({
        id: idx + 1,
        sender: sender,
        senderName: msg.name || '',
        content: content,
        time: time
      });
    });

    return messages;
  }

  // 2. 如果未找到 QQ JSON 数据，回退到通用 HTML 文本提取
  const stripped = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '');
  return parseTxtChat(stripped);
}

// Excel 解析
function parseExcelChat(data) {
  const messages = [];
  if (!data || data.length < 2) return messages;

  const header = data[0].map(h => String(h || '').toLowerCase());
  const timeIdx = header.findIndex(h => h.includes('time') || h.includes('时间') || h.includes('日期'));
  const senderIdx = header.findIndex(h => h.includes('sender') || h.includes('发送') || h.includes('name') || h.includes('姓名'));
  const contentIdx = header.findIndex(h => h.includes('content') || h.includes('内容') || h.includes('message') || h.includes('text'));

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.every(c => !c)) continue;
    const content = contentIdx >= 0 ? String(row[contentIdx] || '').trim() : String(row[row.length - 1] || '').trim();
    if (!content) continue;
    messages.push({
      id: messages.length + 1,
      sender: 'other',
      senderName: senderIdx >= 0 ? String(row[senderIdx] || '').trim() : '',
      content: content,
      time: timeIdx >= 0 ? String(row[timeIdx] || '').trim() : ''
    });
  }
  return messages;
}

// 上传视频
ipcMain.handle('upload-video', async (event, { filePath, albumId, note }) => {
  try {
    const photos = readJSON('photos.json', []);
    const ext = path.extname(filePath);
    const filename = Date.now() + '_' + Math.random().toString(36).substr(2, 6) + ext;
    const destPath = path.join(videosPath, filename);
    
    fs.copyFileSync(filePath, destPath);
    
    const video = {
      id: Date.now(),
      filename,
      albumId: albumId || 'daily',
      note: note || '',
      type: 'video',
      uploadedAt: new Date().toISOString()
    };
    photos.push(video);
    writeJSON('photos.json', photos);
    
    return { success: true, video };
  } catch (e) {
    console.error('上传视频失败:', e);
    return { success: false, error: e.message };
  }
});

// 删除照片/视频
ipcMain.handle('delete-media', (event, id) => {
  let photos = readJSON('photos.json', []);
  const item = photos.find(p => p.id === id);
  if (item) {
    const mediaPath = item.type === 'video' ? videosPath : photosPath;
    const filePath = path.join(mediaPath, item.filename);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      console.error('删除文件失败:', e);
    }
  }
  photos = photos.filter(p => p.id !== id);
  const success = writeJSON('photos.json', photos);
  return { success };
});

// 获取照片/视频文件路径
ipcMain.handle('get-media-path', (event, { filename, type }) => {
  const mediaPath = type === 'video' ? videosPath : photosPath;
  return path.join(mediaPath, filename);
});

// 打开文件选择对话框
ipcMain.handle('open-file-dialog', (event, options) => {
  return dialog.showOpenDialog(mainWindow, options || {
    properties: ['openFile'],
    filters: [
      { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] },
      { name: '视频', extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
});

// 导出数据备份
ipcMain.handle('export-backup', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出备份',
    defaultPath: `时光纪念册备份_${new Date().toISOString().slice(0,10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  
  if (result.canceled) return { success: false, canceled: true };
  
  try {
    const backup = {
      version: '1.0',
      exportTime: new Date().toISOString(),
      settings: readJSON('settings.json', {}),
      diaries: readJSON('diaries.json', []),
      albums: readJSON('albums.json', []),
      photos: readJSON('photos.json', [])
    };
    delete backup.settings.passwordHash;
    fs.writeFileSync(result.filePath, JSON.stringify(backup, null, 2), 'utf-8');
    return { success: true, path: result.filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 导入数据备份
ipcMain.handle('import-backup', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入备份',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  
  if (result.canceled) return { success: false, canceled: true };
  
  try {
    const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf-8'));
    if (data.settings) {
      const current = readJSON('settings.json', {});
      writeJSON('settings.json', { ...current, ...data.settings, passwordHash: current.passwordHash });
    }
    if (data.diaries) writeJSON('diaries.json', data.diaries);
    if (data.albums) writeJSON('albums.json', data.albums);
    if (data.photos) writeJSON('photos.json', data.photos);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ==================== 单篇日记导入导出 ====================

// 导出单篇日记
ipcMain.handle('export-diary-file', async (event, { diary, format }) => {
  try {
    if (!diary || !diary.content) {
      return { success: false, error: '日记内容为空' };
    }

    const dateStr = (diary.date || '未知日期').replace(/[\/\\:*?"<>|]/g, '-');
    const moods = Array.isArray(diary.moods) ? diary.moods : (diary.mood ? [diary.mood] : ['normal']);
    const moodLabel = moods.length > 0 ? '_' + moods.join('-') : '';
    let defaultPath = '';
    let filters = [];
    let fileContent = '';
    let encoding = 'utf-8';

    // 去除 Markdown 标记获得纯文本
    const plainText = diary.content
      .replace(/#{1,6}\s/g, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/<u>(.+?)<\/u>/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`{1,3}[^`]*`{1,3}/g, '')
      .replace(/!\[.*?\]\(.*?\)/g, '[图片]')
      .replace(/\[(.+?)\]\(.*?\)/g, '$1')
      .replace(/^>\s/gm, '')
      .replace(/^[-*+]\s/gm, '')
      .replace(/^\d+\.\s/gm, '')
      .replace(/^[-*_]{3,}\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n');

    switch (format) {
      case 'md':
        defaultPath = `日记_${dateStr}${moodLabel}.md`;
        filters = [{ name: 'Markdown', extensions: ['md'] }];
        fileContent = diary.content;
        break;

      case 'txt':
        defaultPath = `日记_${dateStr}${moodLabel}.txt`;
        filters = [{ name: '文本文件', extensions: ['txt'] }];
        fileContent = `日期：${diary.date || '未知'}\n心情：${moods.map(m => moodNameMap[m] || m).join('、') || '未知'}\n\n${plainText}`;
        break;

      case 'docx': {
        defaultPath = `日记_${dateStr}${moodLabel}.doc`;
        filters = [{ name: 'Word 文档', extensions: ['doc'] }];
        // 生成 MIME HTML 格式，Word 可原生打开
        const moodNameMap = {
          happy: '开心', sad: '难过', miss: '想念', calm: '平静', angry: '生气',
          surprised: '惊喜', love: '心动', normal: '一般', excited: '兴奋', grateful: '感恩',
          anxious: '焦虑', lonely: '孤独', tired: '疲惫', hopeful: '期待', proud: '自豪',
          confused: '困惑', sweet: '甜蜜', touched: '感动', guilty: '内疚', bored: '无聊'
        };
        const moodName = moods.map(m => moodNameMap[m] || m).join('、') || '一般';
        // 简单 Markdown → HTML 转换
        let htmlContent = diary.content
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/^### (.+)$/gm, '<h3>$1</h3>')
          .replace(/^## (.+)$/gm, '<h2>$1</h2>')
          .replace(/^# (.+)$/gm, '<h1>$1</h1>')
          .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
          .replace(/\*(.+?)\*/g, '<i>$1</i>')
          .replace(/~~(.+?)~~/g, '<s>$1</s>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/!\[(.*?)\]\((.+?)\)/g, '<br><i>[图片：$1]</i><br>')
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
          .replace(/\n/g, '<br>\n');

        fileContent = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8"><title>日记_${dateStr}</title>
<style>body{font-family:'Microsoft YaHei',sans-serif;line-height:1.8;padding:40px;max-width:800px;margin:0 auto;color:#333;}
h1{color:#ff6b9d;border-bottom:2px solid #ff6b9d;padding-bottom:8px;}
h2{color:#e8588c;}
h3{color:#d04478;}
code{background:#f5f5f5;padding:2px 6px;border-radius:4px;}
a{color:#ff6b9d;}
</style></head><body>
<h1>💝 时光纪念册 - 日记</h1>
<p><b>日期：</b>${diary.date || '未知'} &nbsp;&nbsp; <b>心情：</b>${moodName} &nbsp;&nbsp; <b>字数：</b>${diary.wordCount || 0}</p>
<hr>
${htmlContent}
</body></html>`;
        break;
      }

      case 'pdf': {
        defaultPath = `日记_${dateStr}${moodLabel}.pdf`;
        filters = [{ name: 'PDF 文件', extensions: ['pdf'] }];
        // PDF 通过 save dialog 获取路径后生成
        break;
      }

      default:
        return { success: false, error: '不支持的导出格式' };
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出日记',
      defaultPath: defaultPath,
      filters: filters
    });

    if (result.canceled) return { success: false, canceled: true };

    if (format === 'pdf') {
      // 使用 Electron 生成 PDF
      return await exportDiaryToPdf(mainWindow, diary, result.filePath);
    } else {
      fs.writeFileSync(result.filePath, fileContent, encoding);
      return { success: true, path: result.filePath };
    }
  } catch (e) {
    console.error('导出日记失败:', e);
    return { success: false, error: e.message };
  }
});

// 使用隐藏窗口生成 PDF
async function exportDiaryToPdf(parentWindow, diary, filePath) {
  return new Promise((resolve) => {
    const moodNameMap = {
      happy: '开心', sad: '难过', miss: '想念', calm: '平静', angry: '生气',
      surprised: '惊喜', love: '心动', normal: '一般', excited: '兴奋', grateful: '感恩',
      anxious: '焦虑', lonely: '孤独', tired: '疲惫', hopeful: '期待', proud: '自豪',
      confused: '困惑', sweet: '甜蜜', touched: '感动', guilty: '内疚', bored: '无聊'
    };
    const pdfMoods = Array.isArray(diary.moods) ? diary.moods : (diary.mood ? [diary.mood] : ['normal']);
    const moodName = pdfMoods.map(m => moodNameMap[m] || m).join('、') || '一般';

    let htmlContent = diary.content
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/!\[(.*?)\]\((.+?)\)/g, '<br><i>[图片：$1]</i><br>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\n/g, '<br>\n');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:'Microsoft YaHei',sans-serif;line-height:2;padding:60px;max-width:750px;margin:0 auto;color:#333;font-size:15px;}
h1{color:#ff6b9d;font-size:24px;border-bottom:2px solid #ff6b9d;padding-bottom:8px;margin-top:0;}
h2{color:#e8588c;font-size:20px;}
h3{color:#d04478;font-size:17px;}
code{background:#f5f5f5;padding:2px 6px;border-radius:4px;font-family:Consolas,monospace;}
a{color:#ff6b9d;}
.meta{color:#999;font-size:13px;margin-bottom:20px;}
hr{border:none;border-top:1px solid #eee;margin:20px 0;}
</style></head><body>
<h1>💝 时光纪念册 - 日记</h1>
<div class="meta"><b>日期：</b>${diary.date || '未知'} &nbsp;&nbsp; <b>心情：</b>${moodName} &nbsp;&nbsp; <b>字数：</b>${diary.wordCount || 0}</div>
<hr>${htmlContent}</body></html>`;

    const pdfWin = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    const tempHtmlPath = path.join(dataPath, '_temp_diary_export.html');
    fs.writeFileSync(tempHtmlPath, html, 'utf-8');

    pdfWin.loadFile(tempHtmlPath);

    pdfWin.webContents.on('did-finish-load', async () => {
      try {
        const pdfData = await pdfWin.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true,
          margins: { top: 0, bottom: 0, left: 0, right: 0 }
        });
        fs.writeFileSync(filePath, pdfData);
        // 清理临时文件
        try { fs.unlinkSync(tempHtmlPath); } catch (e) { /* ignore */ }
        pdfWin.close();
        resolve({ success: true, path: filePath });
      } catch (e) {
        try { fs.unlinkSync(tempHtmlPath); } catch (err) { /* ignore */ }
        pdfWin.close();
        resolve({ success: false, error: e.message });
      }
    });

    pdfWin.webContents.on('did-fail-load', () => {
      try { fs.unlinkSync(tempHtmlPath); } catch (e) { /* ignore */ }
      pdfWin.close();
      resolve({ success: false, error: 'PDF 生成失败' });
    });
  });
}

// 导入单篇日记文件
ipcMain.handle('import-diary-file', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入日记文件',
      filters: [
        { name: '支持的文件', extensions: ['txt', 'md', 'docx', 'pdf'] },
        { name: '文本文件', extensions: ['txt'] },
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Word 文档', extensions: ['docx'] },
        { name: 'PDF 文件', extensions: ['pdf'] }
      ],
      properties: ['openFile']
    });

    if (result.canceled || !result.filePaths.length) {
      return { success: false, canceled: true };
    }

    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    let content = '';

    if (ext === '.txt' || ext === '.md') {
      content = fs.readFileSync(filePath, 'utf-8');
    } else if (ext === '.docx') {
      const mammothResult = await mammoth.extractRawText({ path: filePath });
      content = mammothResult.value;
    } else if (ext === '.pdf') {
      const pdfBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(pdfBuffer);
      content = pdfData.text;
    } else {
      return { success: false, error: '不支持的文件格式：' + ext };
    }

    if (!content || !content.trim()) {
      return { success: false, error: '未能从文件中读取到内容' };
    }

    return { success: true, content: content.trim() };
  } catch (e) {
    console.error('导入日记文件失败:', e);
    return { success: false, error: e.message };
  }
});

// 一键初始化所有数据（需密码验证）
ipcMain.handle('reset-all-data', async (event, password) => {
  try {
    // 验证密码
    const settings = readJSON('settings.json', {});
    const hash = sha256(password);
    if (hash !== settings.passwordHash) {
      return { success: false, error: '密码错误' };
    }
    
    // 清空所有数据文件
    writeJSON('settings.json', {});           // 密码、认识日期、生日、分手记录、主题等全部清空
    writeJSON('diaries.json', []);
    writeJSON('albums.json', [
      { id: 'daily', name: '日常', count: 0 },
      { id: 'travel', name: '旅行', count: 0 },
      { id: 'anniversary', name: '纪念日', count: 0 }
    ]);
    writeJSON('photos.json', []);
    writeJSON('chats.json', []);
    
    // 删除所有照片和视频文件
    try {
      const photoFiles = fs.readdirSync(photosPath);
      photoFiles.forEach(f => {
        fs.unlinkSync(path.join(photosPath, f));
      });
    } catch (e) { /* ignore */ }
    try {
      const videoFiles = fs.readdirSync(videosPath);
      videoFiles.forEach(f => {
        fs.unlinkSync(path.join(videosPath, f));
      });
    } catch (e) { /* ignore */ }
    
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
