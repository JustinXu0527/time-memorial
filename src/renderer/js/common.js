// 通用工具函数

const { ipcRenderer } = require('electron');

// Toast 提示
function showToast(message, type = 'info') {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  
  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️'
  };
  
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
  
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// 格式化日期（兼容纯日期和 datetime）
function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    // 尝试兼容 "YYYY-MM-DD HH:mm" 格式
    const d = new Date(dateStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return dateStr;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

// 格式化日期时间（精确到秒）
function formatDateTime(dateStr) {
  if (!dateStr) return '';
  // 兼容多种 datetime 格式
  const normalized = dateStr.replace(' ', 'T');
  const date = new Date(normalized);
  if (isNaN(date.getTime())) return dateStr;
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}年${mo}月${d}日 ${h}:${mi}:${s}`;
}

// 计算两个时间点之间的秒数（精确）
function secondsBetween(str1, str2) {
  const d1 = new Date(str1.replace(' ', 'T'));
  const d2 = new Date(str2.replace(' ', 'T'));
  return Math.abs(Math.floor((d2 - d1) / 1000));
}

// 计算两个日期之间的天数（忽略时间，仅日期）
function daysBetween(date1, date2) {
  const oneDay = 24 * 60 * 60 * 1000;
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return Math.round(Math.abs((d2 - d1) / oneDay));
}

// 格式化秒数为 "X天 X时 X分 X秒"
function formatDuration(totalSeconds) {
  if (totalSeconds < 0) totalSeconds = 0;
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let result = '';
  if (days > 0) result += `${days}天 `;
  if (hours > 0 || result) result += `${hours}时 `;
  if (minutes > 0 || result) result += `${minutes}分 `;
  result += `${seconds}秒`;
  return result;
}

// 格式化秒数为纯数字展示（首页大数字用）
function formatDurationShort(totalSeconds) {
  if (totalSeconds < 0) totalSeconds = 0;
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days.toLocaleString()}<span class="hero-days-unit">天</span>`;
  if (hours > 0) return `${hours}<span class="hero-days-unit">时</span>`;
  return `${minutes}<span class="hero-days-unit">分</span>`;
}

// 根据 breakupRecords 计算在一起总秒数和分开总秒数
function calcTotalTimes(meetDate, breakupRecords) {
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

  let currentStatus = 'together'; // 默认在一起
  let lastPoint = meetTime;

  sortedRecords.forEach((record, idx) => {
    const breakupTime = new Date(record.breakupDate.replace(' ', 'T'));
    const reunionTime = record.reunionDate ? new Date(record.reunionDate.replace(' ', 'T')) : null;

    // 从上一个时间点到分手 = 在一起
    if (breakupTime > lastPoint) {
      togetherSeconds += Math.floor((breakupTime - lastPoint) / 1000);
    }

    if (reunionTime && reunionTime > breakupTime) {
      // 复合了：从分手到复合 = 分开
      apartSeconds += Math.floor((reunionTime - breakupTime) / 1000);
      lastPoint = reunionTime;
      if (idx === sortedRecords.length - 1) {
        currentStatus = 'together';
      }
    } else {
      // 没有复合：从分手到现在 = 分开
      apartSeconds += Math.floor((now - breakupTime) / 1000);
      lastPoint = now;
      currentStatus = 'breakup';
    }
  });

  // 如果当前还在一起，加上从 lastPoint 到 now 的时间
  if (currentStatus === 'together' && lastPoint < now) {
    togetherSeconds += Math.floor((now - lastPoint) / 1000);
  }

  return { togetherSeconds, apartSeconds, status: currentStatus };
}

// 获取当前感情状态
function getCurrentStatus(breakupRecords) {
  if (!breakupRecords || breakupRecords.length === 0) return 'together';
  const sorted = [...breakupRecords]
    .filter(r => r.breakupDate)
    .sort((a, b) => new Date(a.breakupDate.replace(' ', 'T')) - new Date(b.breakupDate.replace(' ', 'T')));
  if (sorted.length === 0) return 'together';
  const last = sorted[sorted.length - 1];
  return last.reunionDate ? 'together' : 'breakup';
}

// 计算距离下次生日的天数
function daysUntilBirthday(birthdayStr) {
  if (!birthdayStr) return null;
  const today = new Date();
  const birthday = new Date(birthdayStr);
  const thisYearBirthday = new Date(today.getFullYear(), birthday.getMonth(), birthday.getDate());
  
  if (thisYearBirthday < today) {
    thisYearBirthday.setFullYear(today.getFullYear() + 1);
  }
  
  const oneDay = 24 * 60 * 60 * 1000;
  today.setHours(0, 0, 0, 0);
  thisYearBirthday.setHours(0, 0, 0, 0);
  return Math.round((thisYearBirthday - today) / oneDay);
}

// 获取设置
async function getSettings() {
  return await ipcRenderer.invoke('get-settings');
}

// 保存设置
async function saveSettings(settings) {
  return await ipcRenderer.invoke('save-settings', settings);
}

// 获取日记
async function getDiaries() {
  return await ipcRenderer.invoke('get-diaries');
}

// 保存日记
async function saveDiary(diary) {
  return await ipcRenderer.invoke('save-diary', diary);
}

// 删除日记
async function deleteDiary(id) {
  return await ipcRenderer.invoke('delete-diary', id);
}

// 获取日记统计
async function getDiaryStats() {
  return await ipcRenderer.invoke('get-diary-stats');
}

// 获取相册
async function getAlbums() {
  return await ipcRenderer.invoke('get-albums');
}

// 获取照片
async function getPhotos(albumId) {
  return await ipcRenderer.invoke('get-photos', albumId);
}

// 上传照片
async function uploadPhoto(filePath, albumId, note) {
  return await ipcRenderer.invoke('upload-photo', { filePath, albumId, note });
}

// 上传视频
async function uploadVideo(filePath, albumId, note) {
  return await ipcRenderer.invoke('upload-video', { filePath, albumId, note });
}

// 删除媒体
async function deleteMedia(id) {
  return await ipcRenderer.invoke('delete-media', id);
}

// 获取媒体路径
async function getMediaPath(filename, type) {
  return await ipcRenderer.invoke('get-media-path', { filename, type });
}

// 打开文件选择对话框
async function openFileDialog(options) {
  return await ipcRenderer.invoke('open-file-dialog', options);
}

// 导出备份
async function exportBackup() {
  return await ipcRenderer.invoke('export-backup');
}

// 导入备份
async function importBackup() {
  return await ipcRenderer.invoke('import-backup');
}

// 一键初始化所有数据
async function resetAllData(password) {
  return await ipcRenderer.invoke('reset-all-data', password);
}

// 应用主题
function applyTheme(theme) {
  document.body.className = '';
  if (theme === 'missing-blue') {
    document.body.classList.add('theme-missing');
  }
}

// 导航到页面
function navigateTo(page) {
  window.location.href = page;
}

// ========== 聊天记录 API ==========

// 获取聊天记录
async function getChats(platform) {
  return await ipcRenderer.invoke('get-chats', platform);
}

// 获取聊天统计
async function getChatStats() {
  return await ipcRenderer.invoke('get-chat-stats');
}

// 导入聊天文件
async function importChatFile(filePath, platform, contactName) {
  return await ipcRenderer.invoke('import-chat-file', { filePath, platform, contactName });
}

// 删除聊天记录
async function deleteChat(id) {
  return await ipcRenderer.invoke('delete-chat', id);
}

// 导出单篇日记文件
async function exportDiaryFile(diary, format) {
  return await ipcRenderer.invoke('export-diary-file', { diary, format });
}

// 导入单篇日记文件
async function importDiaryFile() {
  return await ipcRenderer.invoke('import-diary-file');
}

// 平台信息配置
const platforms = [
  { id: 'wechat', name: '微信', icon: '💬', color: '#07C160' },
  { id: 'qq', name: 'QQ', icon: '🐧', color: '#12B7F5' },
  { id: 'dingtalk', name: '钉钉', icon: '📌', color: '#0089FF' },
  { id: 'telegram', name: 'Telegram', icon: '✈️', color: '#26A5E4' },
  { id: 'whatsapp', name: 'WhatsApp', icon: '💚', color: '#25D366' },
  { id: 'line', name: 'Line', icon: '🟢', color: '#00B900' },
  { id: 'signal', name: 'Signal', icon: '🔐', color: '#3A76F0' },
  { id: 'feishu', name: '飞书', icon: '📄', color: '#3370FF' },
  { id: 'skype', name: 'Skype', icon: '🔵', color: '#00AFF0' },
  { id: 'messenger', name: 'Messenger', icon: '💙', color: '#0084FF' },
  { id: 'sms', name: '短信', icon: '📱', color: '#5B9BD5' },
  { id: 'other', name: '其他', icon: '📝', color: '#8E8E93' }
];

function getPlatformInfo(platformId) {
  return platforms.find(p => p.id === platformId) || platforms[platforms.length - 1];
}

// 心情表情映射
const moodEmojis = {
  happy: '😊',
  sad: '😢',
  miss: '🥺',
  calm: '😌',
  angry: '😤',
  surprised: '😮',
  love: '🥰',
  normal: '🙂',
  excited: '🤩',
  grateful: '🙏',
  anxious: '😰',
  lonely: '😔',
  tired: '😴',
  hopeful: '🌟',
  proud: '😎',
  confused: '😵',
  sweet: '🍬',
  touched: '🥲',
  guilty: '😣',
  bored: '😑'
};

const moodNames = {
  happy: '开心',
  sad: '难过',
  miss: '想念',
  calm: '平静',
  angry: '生气',
  surprised: '惊喜',
  love: '心动',
  normal: '一般',
  excited: '兴奋',
  grateful: '感恩',
  anxious: '焦虑',
  lonely: '孤独',
  tired: '疲惫',
  hopeful: '期待',
  proud: '自豪',
  confused: '困惑',
  sweet: '甜蜜',
  touched: '感动',
  guilty: '内疚',
  bored: '无聊'
};

// 生成日历数据
function generateCalendar(year, month) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startDay = firstDay.getDay();
  
  const days = [];
  for (let i = 0; i < startDay; i++) {
    days.push(null);
  }
  for (let i = 1; i <= daysInMonth; i++) {
    days.push(i);
  }
  return days;
}
