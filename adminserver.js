const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const os = require('os');
const WebSocket = require('ws');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { execSync } = require('child_process');

// ============================================================
// 路径配置
// ============================================================
const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const ADMIN_CONFIG_PATH = path.join(PROJECT_ROOT, 'adminconfig.json');
const ADMIN_PUB_KEY_PATH = path.join(PROJECT_ROOT, 'admin.pub');

// 确保 public 目录存在
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

// ============================================================
// 控制台日志
// ============================================================
function log(message, type) {
  if (typeof type === 'undefined') type = 'INFO';
  var timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log('[' + timestamp + '] [ADMIN] [' + type + '] ' + message);
}

// ============================================================
// 读取后台配置
// ============================================================
function getAdminConfig() {
  try {
    if (!fs.existsSync(ADMIN_CONFIG_PATH)) {
      var defaultConfig = {
        background: null,
        adminPort: 8443,
        https: { enabled: 'auto', keyPath: 'sslkey/privkey.pem', certPath: 'sslkey/fullchain.pem' },
        session: { timeout: 604800 },
        title: 'MinecraftSniper服务器管理面板',
        version: 'MinecraftSniper ServerAdmin Manager EOL'
      };
      fs.writeFileSync(ADMIN_CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf-8');
      log('adminconfig.json 已自动创建默认配置', 'INFO');
      return defaultConfig;
    }
    var raw = fs.readFileSync(ADMIN_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    log('读取 adminconfig.json 失败: ' + err.message, 'ERROR');
    return null;
  }
}

function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

// ============================================================
// 公钥管理
// ============================================================
function getPublicKey() {
  try {
    if (fs.existsSync(ADMIN_PUB_KEY_PATH)) {
      return fs.readFileSync(ADMIN_PUB_KEY_PATH, 'utf-8').trim();
    }
    return null;
  } catch (e) {
    return null;
  }
}

function savePublicKey(pubKey) {
  fs.writeFileSync(ADMIN_PUB_KEY_PATH, pubKey, 'utf-8');
}

function getKeyFingerprint(pubKey) {
  var hash = crypto.createHash('sha256').update(pubKey).digest('hex');
  return 'SHA256:' + hash.match(/.{2}/g).join(':');
}

function verifyPrivateKey(privateKey) {
  var pubKey = getPublicKey();
  if (!pubKey) return false;
  try {
    var testData = Buffer.from('MinecraftSniperAuthTest');
    var sign = crypto.createSign('RSA-SHA256');
    sign.update(testData);
    sign.end();
    var signature = sign.sign(privateKey, 'base64');
    var verify = crypto.createVerify('RSA-SHA256');
    verify.update(testData);
    verify.end();
    return verify.verify(pubKey, signature, 'base64');
  } catch (e) {
    return false;
  }
}

function generateKeyPair() {
  var pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

// ============================================================
// JWT 认证
// ============================================================
var JWT_SECRET = process.env.JWT_SECRET || 'minecraft-sniper-blog-secret-key-2026';

function generateToken(expiry) {
  var payload = {
    exp: Math.floor(Date.now() / 1000) + expiry,
    iat: Math.floor(Date.now() / 1000)
  };
  var header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  var payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  var signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(header + '.' + payloadEncoded)
    .digest('base64url');
  return header + '.' + payloadEncoded + '.' + signature;
}

function verifyToken(token) {
  try {
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    var header = parts[0];
    var payloadEncoded = parts[1];
    var signature = parts[2];
    var expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(header + '.' + payloadEncoded)
      .digest('base64url');
    if (signature !== expectedSig) return null;
    var payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function authenticateToken(req, res, next) {
  var authHeader = req.headers['authorization'];
  var token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  if (!token) {
    return res.status(401).json({ error: '未提供认证 Token' });
  }
  var payload = verifyToken(token);
  if (!payload) {
    return res.status(403).json({ error: 'Token 无效或已过期' });
  }
  next();
}

// ============================================================
// ★★★ Multer 配置：diskStorage（流式写入磁盘，支持大文件）★★★
// ============================================================
var storage = multer.diskStorage({
  destination: function(req, file, cb) {
    var targetDir = req.query.path || process.cwd();
    var realTargetDir = path.resolve(targetDir);
    if (!fs.existsSync(realTargetDir)) {
      fs.mkdirSync(realTargetDir, { recursive: true });
    }
    cb(null, realTargetDir);
  },
  filename: function(req, file, cb) {
    var filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
    filename = filename.replace(/[\/\\:*?"<>|]/g, '_');
    cb(null, filename);
  }
});

var upload = multer({
  storage: storage,
  limits: { fileSize: Infinity }
});

// ============================================================
// 通用上传处理
// ============================================================
function handleFileUpload(req, res) {
  upload.single('file')(req, res, function(err) {
    if (err) {
      log('multer 错误: ' + err.message, 'ERROR');
      return res.status(400).json({ success: false, message: err.message });
    }
    var file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, message: '未上传文件' });
    }

    try {
      var stats = fs.statfsSync(PROJECT_ROOT);
      var freeGB = (stats.bfree * stats.bsize) / 1024 / 1024 / 1024;
      if (freeGB < 0.5) {
        fs.unlinkSync(file.path);
        return res.status(507).json({ success: false, message: '磁盘剩余空间不足 500MB，拒绝上传' });
      }
    } catch (e) {}

    log('文件上传成功: ' + file.filename + ' (' + (file.size / 1024 / 1024).toFixed(2) + ' MB)', 'INFO');
    return res.json({ success: true, filename: file.filename, path: file.path });
  });
}

// ============================================================
// 系统监控数据采集
// ============================================================

var lastCpuTimes = null;
var lastCpuTimestamp = null;

var cachedDiskHealth = null;
var cachedDiskHealthTime = 0;
var DISK_HEALTH_CACHE_SECONDS = 120;

var cachedCpuTemp = null;
var cachedCpuTempTime = 0;
var CPU_TEMP_CACHE_SECONDS = 60;

var networkSnapshot = null;
var networkSampleTime = null;

function getCpuUsage() {
  try {
    var cpus = os.cpus();
    if (!cpus || cpus.length === 0) {
      var loadAvg = os.loadavg();
      return {
        usage: Math.min(100, Math.round((loadAvg[0] / 1) * 100)) || 0,
        loadavg: loadAvg.map(function(v) { return v.toFixed(2); })
      };
    }

    var totalUser = 0, totalSys = 0, totalIdle = 0, totalNice = 0, totalIrq = 0;
    for (var i = 0; i < cpus.length; i++) {
      var cpu = cpus[i];
      totalUser += cpu.times.user;
      totalSys += cpu.times.sys;
      totalIdle += cpu.times.idle;
      totalNice += cpu.times.nice || 0;
      totalIrq += cpu.times.irq || 0;
    }
    var total = totalUser + totalSys + totalIdle + totalNice + totalIrq;
    var idle = totalIdle;

    var now = Date.now();

    if (lastCpuTimes === null) {
      lastCpuTimes = { total: total, idle: idle };
      lastCpuTimestamp = now;
      return { usage: 0, loadavg: os.loadavg().map(function(v) { return v.toFixed(2); }) };
    }

    var deltaTotal = total - lastCpuTimes.total;
    var deltaIdle = idle - lastCpuTimes.idle;
    var deltaUsage = deltaTotal - deltaIdle;
    var usage = deltaTotal > 0 ? Math.round((deltaUsage / deltaTotal) * 100) : 0;

    lastCpuTimes = { total: total, idle: idle };
    lastCpuTimestamp = now;

    return {
      usage: Math.min(100, Math.max(0, usage)),
      loadavg: os.loadavg().map(function(v) { return v.toFixed(2); })
    };
  } catch (err) {
    log('获取 CPU 信息失败: ' + err.message, 'WARN');
    return { usage: 0, loadavg: ['0.00', '0.00', '0.00'] };
  }
}

function getCpuTemperature() {
  var now = Date.now();
  if (cachedCpuTemp && (now - cachedCpuTempTime) < CPU_TEMP_CACHE_SECONDS * 1000) {
    return cachedCpuTemp;
  }

  var temp = null;
  var status = '不可用';
  var updated = new Date().toLocaleString();

  if (process.platform !== 'linux') {
    cachedCpuTemp = { temp: '--', status: '不支持 (非Linux)', updated: updated };
    cachedCpuTempTime = now;
    return cachedCpuTemp;
  }

  try {
    var thermalPath = '/sys/class/thermal/thermal_zone0/temp';
    if (fs.existsSync(thermalPath)) {
      var raw = fs.readFileSync(thermalPath, 'utf-8').trim();
      var val = parseInt(raw);
      if (!isNaN(val) && val > 0) {
        temp = (val / 1000).toFixed(1);
      }
    }

    if (temp === null) {
      try {
        var output = execSync('sensors -u | grep -m1 "temp1_input" | awk "{print \\$2}"', {
          encoding: 'utf-8',
          timeout: 2000,
          shell: '/bin/bash'
        });
        var val2 = parseFloat(output.trim());
        if (!isNaN(val2) && val2 > 0) {
          temp = val2.toFixed(1);
        }
      } catch (e) {}
    }

    if (temp === null) {
      try {
        var output2 = execSync('vcgencmd measure_temp', { encoding: 'utf-8', timeout: 2000 });
        var match = output2.match(/temp=([\d.]+)/);
        if (match) {
          temp = match[1];
        }
      } catch (e) {}
    }

    if (temp !== null) {
      var t = parseFloat(temp);
      if (t < 50) status = '正常';
      else if (t < 75) status = '偏高';
      else status = '过热 ⚠️';
    } else {
      temp = '--';
      status = '不可用 (无温度传感器)';
    }
  } catch (err) {
    log('获取 CPU 温度失败: ' + err.message, 'WARN');
    temp = '--';
    status = '读取失败';
  }

  cachedCpuTemp = { temp: temp, status: status, updated: updated };
  cachedCpuTempTime = now;
  return cachedCpuTemp;
}

function getDiskUsage() {
  try {
    var stats = fs.statfsSync(__dirname);
    var total = stats.blocks * stats.bsize;
    var free = stats.bfree * stats.bsize;
    var used = total - free;

    if (total === 0) {
      throw new Error('无法获取磁盘信息（total = 0）');
    }

    return {
      totalGB: (total / 1024 / 1024 / 1024).toFixed(1),
      usedGB: (used / 1024 / 1024 / 1024).toFixed(1),
      usedPercent: Math.round((used / total) * 100)
    };
  } catch (err) {
    log('获取磁盘信息失败（statfs）: ' + err.message, 'WARN');
    return {
      totalGB: '--',
      usedGB: '--',
      usedPercent: 0
    };
  }
}

function getDiskHealth() {
  var now = Date.now();
  if (cachedDiskHealth && (now - cachedDiskHealthTime) < DISK_HEALTH_CACHE_SECONDS * 1000) {
    return cachedDiskHealth;
  }

  var health = '--';
  var status = '--';
  var powerOnHours = '--';
  var usedGB = '--';
  var totalGB = '--';

  var diskStats = getDiskUsage();
  usedGB = diskStats.usedGB;
  totalGB = diskStats.totalGB;

  if (process.platform !== 'linux') {
    health = '☁️ 跨平台';
    status = 'S.M.A.R.T 仅 Linux 支持';
    cachedDiskHealth = { health: health, status: status, powerOnHours: powerOnHours, usedGB: usedGB, totalGB: totalGB };
    cachedDiskHealthTime = now;
    return cachedDiskHealth;
  }

  var smartctlExists = false;
  try {
    execSync('which smartctl', { encoding: 'utf-8', timeout: 3000, stdio: 'ignore' });
    smartctlExists = true;
  } catch (e) {}

  if (!smartctlExists) {
    health = '❌ 未安装';
    status = 'smartctl 未安装，请安装 smartmontools';
    cachedDiskHealth = { health: health, status: status, powerOnHours: powerOnHours, usedGB: usedGB, totalGB: totalGB };
    cachedDiskHealthTime = now;
    return cachedDiskHealth;
  }

  var diskDevice = null;
  var possibleDevices = ['/dev/sda', '/dev/vda', '/dev/nvme0n1', '/dev/mmcblk0'];

  for (var i = 0; i < possibleDevices.length; i++) {
    if (fs.existsSync(possibleDevices[i])) {
      diskDevice = possibleDevices[i];
      break;
    }
  }

  if (!diskDevice) {
    try {
      var lsblkOut = execSync('lsblk -nd -o NAME | head -1', { encoding: 'utf-8', timeout: 3000 });
      var devName = lsblkOut.trim();
      if (devName) {
        diskDevice = '/dev/' + devName;
      }
    } catch (e) {}
  }

  if (!diskDevice) {
    health = '❓ 无磁盘';
    status = '未找到可识别的磁盘设备';
    cachedDiskHealth = { health: health, status: status, powerOnHours: powerOnHours, usedGB: usedGB, totalGB: totalGB };
    cachedDiskHealthTime = now;
    return cachedDiskHealth;
  }

  var smartAvailable = false;
  try {
    var supportCheck = execSync('sudo smartctl -i ' + diskDevice + ' 2>/dev/null | grep -i "SMART support is"', {
      encoding: 'utf-8',
      timeout: 5000
    });
    if (supportCheck && (supportCheck.indexOf('Available') !== -1 || supportCheck.indexOf('Enabled') !== -1)) {
      smartAvailable = true;
    }
  } catch (e) {}

  if (!smartAvailable) {
    health = '⚠️ 不支持';
    status = '设备不支持 S.M.A.R.T（U盘或虚拟磁盘）';
    var usage = parseFloat(diskStats.usedPercent);
    if (!isNaN(usage)) {
      if (usage < 80) {
        status += '，空间充足 (' + usage + '%)';
      } else if (usage < 90) {
        status += '，空间紧张 (' + usage + '%)';
      } else {
        status += '，⚠️ 空间不足 (' + usage + '%)';
      }
    }
    cachedDiskHealth = { health: health, status: status, powerOnHours: powerOnHours, usedGB: usedGB, totalGB: totalGB };
    cachedDiskHealthTime = now;
    return cachedDiskHealth;
  }

  var smartOutput = '';
  try {
    smartOutput = execSync('sudo smartctl -H ' + diskDevice + ' 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000
    });
  } catch (e) {}

  if (smartOutput) {
    if (smartOutput.indexOf('PASSED') !== -1) {
      health = '✅ 良好';
      status = '正常';
    } else if (smartOutput.indexOf('FAILED') !== -1 || smartOutput.indexOf('FAILING') !== -1) {
      health = '⚠️ 警告';
      status = '警告 (建议备份)';
    } else {
      health = '❓ 未知';
      status = '无法判断';
    }

    try {
      var pohOutput = execSync('sudo smartctl -A ' + diskDevice + ' 2>/dev/null | grep -E "Power_On_Hours|Power-On Hours" | awk \'{print $NF}\'', {
        encoding: 'utf-8',
        timeout: 5000
      });
      var poh = parseInt(pohOutput.trim());
      if (!isNaN(poh) && poh > 0) {
        powerOnHours = poh;
      }
    } catch (e) {}
  } else {
    health = '❌ 读取失败';
    status = 'S.M.A.R.T 数据读取失败 (可能需要 root 权限)';
  }

  cachedDiskHealth = { health: health, status: status, powerOnHours: powerOnHours, usedGB: usedGB, totalGB: totalGB };
  cachedDiskHealthTime = now;
  return cachedDiskHealth;
}

function getNetworkUsage() {
  try {
    var totalRx = 0, totalTx = 0;

    if (process.platform === 'linux') {
      var netDev = fs.readFileSync('/proc/net/dev', 'utf-8');
      var lines = netDev.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var match = line.match(/^\s*(\w+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
        if (match) {
          var iface = match[1];
          if (iface === 'lo' || iface === 'docker0' || iface.startsWith('veth')) continue;
          totalRx += parseInt(match[2]) || 0;
          totalTx += parseInt(match[3]) || 0;
        }
      }
    } else if (process.platform === 'win32') {
      try {
        var output = execSync('powershell -Command "Get-NetAdapterStatistics | Where-Object {$_.Name -notlike \'*Loopback*\'} | Select-Object ReceivedBytes, SentBytes"', { encoding: 'utf8', timeout: 3000 });
        var lines2 = output.trim().split('\n').filter(function(l) { return l.trim() && !l.startsWith('Received'); });
        for (var j = 0; j < lines2.length; j++) {
          var parts = lines2[j].trim().split(/\s+/);
          if (parts.length >= 2) {
            totalRx += parseFloat(parts[0]) || 0;
            totalTx += parseFloat(parts[1]) || 0;
          }
        }
      } catch (e) {
        try {
          var output2 = execSync('netstat -e', { encoding: 'utf8', timeout: 3000 });
          var lines3 = output2.split('\n');
          for (var k = 0; k < lines3.length; k++) {
            if (lines3[k].indexOf('Bytes') !== -1) {
              var nums = lines3[k].match(/(\d+)/g);
              if (nums && nums.length >= 2) {
                totalRx = parseInt(nums[0]) || 0;
                totalTx = parseInt(nums[1]) || 0;
                break;
              }
            }
          }
        } catch (e2) {}
      }
    } else {
      try {
        var output3 = execSync('ifconfig | grep "bytes" | grep -v "lo0"', { encoding: 'utf8', timeout: 3000 });
        var lines4 = output3.split('\n');
        for (var l = 0; l < lines4.length; l++) {
          var match2 = lines4[l].match(/bytes[=:]\s*(\d+).*bytes[=:]\s*(\d+)/);
          if (match2) {
            totalRx += parseInt(match2[1]) || 0;
            totalTx += parseInt(match2[2]) || 0;
          }
        }
      } catch (e) {}
    }

    var now = Date.now();
    var speed = 0, rx = 0, tx = 0;
    if (networkSnapshot !== null && networkSampleTime !== null) {
      var timeDiff = (now - networkSampleTime) / 1000;
      if (timeDiff > 0) {
        var rxDiff = totalRx - networkSnapshot.rx;
        var txDiff = totalTx - networkSnapshot.tx;
        rx = (rxDiff / timeDiff) * 8 / 1024 / 1024;
        tx = (txDiff / timeDiff) * 8 / 1024 / 1024;
        speed = Math.max(rx, tx);
        if (speed < 0.01) speed = 0;
        if (speed > 10000) speed = 10000;
      }
    }
    networkSnapshot = { rx: totalRx, tx: totalTx };
    networkSampleTime = now;
    return {
      speed: Math.round(speed * 10) / 10,
      rx: Math.round(rx * 10) / 10,
      tx: Math.round(tx * 10) / 10
    };
  } catch (err) {
    log('获取网络信息失败: ' + err.message, 'WARN');
    return { speed: 0, rx: 0, tx: 0 };
  }
}

function formatUptime(seconds) {
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

// ============================================================
// 文件管理核心函数
// ============================================================

function listDirectory(dirPath) {
  var results = [];
  if (!fs.existsSync(dirPath)) {
    return { error: '目录不存在', files: [] };
  }

  var stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    return { error: '不是目录', files: [] };
  }

  var items = fs.readdirSync(dirPath);
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item === '.' || item === '..') continue;
    var fullPath = path.join(dirPath, item);
    try {
      var itemStat = fs.statSync(fullPath);
      results.push({
        name: item,
        path: fullPath,
        size: itemStat.size,
        modified: itemStat.mtime.toLocaleString(),
        isDir: itemStat.isDirectory()
      });
    } catch (e) {
      continue;
    }
  }

  results.sort(function(a, b) {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  return { files: results };
}

function getParentDir(currentPath) {
  var parent = path.dirname(currentPath);
  if (parent === currentPath) {
    return null;
  }
  return parent;
}

// ============================================================
// HTTPS 启动决策
// ============================================================
function resolveHttpsMode(adminConfig) {
  var httpsConfig = adminConfig.https || {};
  var mode = httpsConfig.enabled || 'auto';
  var keyFile = httpsConfig.keyPath || 'sslkey/privkey.pem';
  var certFile = httpsConfig.certPath || 'sslkey/fullchain.pem';
  var keyPath = path.join(PROJECT_ROOT, keyFile);
  var certPath = path.join(PROJECT_ROOT, certFile);

  var keyExists = fs.existsSync(keyPath);
  var certExists = fs.existsSync(certPath);
  var bothExist = keyExists && certExists;

  if (mode === 'true') {
    if (!bothExist) {
      log('HTTPS 强制启用但证书文件缺失', 'ERROR');
      log('  私钥: ' + keyPath + (keyExists ? ' ✅' : ' ❌ 不存在'), 'ERROR');
      log('  证书: ' + certPath + (certExists ? ' ✅' : ' ❌ 不存在'), 'ERROR');
      return { enabled: false, error: true };
    }
    log('HTTPS 强制启用，证书文件已加载', 'INFO');
    return { enabled: true, keyPath: keyPath, certPath: certPath };
  }

  if (mode === 'false') {
    log('HTTPS 已禁用（用户配置）', 'INFO');
    return { enabled: false };
  }

  if (bothExist) {
    log('HTTPS Auto 模式：检测到证书文件，启用 HTTPS', 'INFO');
    log('  私钥: ' + keyPath, 'INFO');
    log('  证书: ' + certPath, 'INFO');
    return { enabled: true, keyPath: keyPath, certPath: certPath };
  } else {
    log('HTTPS Auto 模式：未检测到完整证书，降级为 HTTP', 'WARN');
    if (!keyExists) log('  缺失: ' + keyFile, 'WARN');
    if (!certExists) log('  缺失: ' + certFile, 'WARN');
    return { enabled: false };
  }
}

// ============================================================
// 创建管理服务
// ============================================================
function createAdminServer() {
  var adminConfig = getAdminConfig();
  if (!adminConfig) {
    log('adminconfig.json 读取失败，管理服务无法启动', 'ERROR');
    return null;
  }

  var adminPort = adminConfig.adminPort;
  if (!isValidPort(adminPort)) {
    log('adminconfig.json 中 adminPort 无效或未配置，管理服务不启动', 'WARN');
    return null;
  }

  var app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ★★★ HTTPS 决策在服务启动前完成 ★★★
  var httpsDecision = resolveHttpsMode(adminConfig);
  if (httpsDecision.error) {
    log('HTTPS 配置错误，管理服务不启动', 'ERROR');
    return null;
  }

  // ============================================================
  // ★★★ HTTPS 中间件：决定是否强制 HTTPS ★★★
  // ============================================================
  app.use(function(req, res, next) {
    if (httpsDecision.enabled) {
      var forwardedProto = req.headers['x-forwarded-proto'];
      var isHttps = forwardedProto === 'https' || req.protocol === 'https';

      // 如果客户端通过 HTTP 访问，且请求的是 API，返回 403
      if (!isHttps && req.path.startsWith('/api/admin')) {
        return res.status(403).json({ 
          error: 'HTTPS Required', 
          message: '请使用 HTTPS 访问此接口' 
        });
      }

      // 可选：HTTP → HTTPS 重定向（针对非 API 请求）
      // 取消注释下方代码可启用自动跳转
      /*
      if (!isHttps && !req.path.startsWith('/api/')) {
        var redirectUrl = 'https://' + req.headers.host + req.url;
        return res.redirect(301, redirectUrl);
      }
      */
    }
    next();
  });

  app.get('/', function(req, res) {
    res.redirect('/login.html');
  });

  // ============================================================
  // ★★★ 公共接口（无需认证）★★★
  // ============================================================
  app.get('/api/admin/config', function(req, res) {
    try {
      var config = getAdminConfig();
      res.json({
        background: config.background || null,
        title: config.title || '服务器管理面板',
        version: config.version || '1.0'
      });
    } catch (err) {
      log('GET /api/admin/config 错误: ' + err.message, 'ERROR');
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/verify', function(req, res) {
    try {
      var authHeader = req.headers['authorization'];
      var token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
      if (!token) return res.json({ valid: false });
      var payload = verifyToken(token);
      res.json({ valid: !!payload });
    } catch (err) {
      log('GET /api/admin/verify 错误: ' + err.message, 'ERROR');
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/auth', function(req, res) {
    try {
      var privateKey = req.body.privateKey;
      if (!privateKey) {
        return res.status(400).json({ success: false, message: '未提供私钥' });
      }
      var isValid = verifyPrivateKey(privateKey);
      if (!isValid) {
        return res.status(401).json({ success: false, message: '私钥验证失败' });
      }
      var expiry = adminConfig.session?.timeout || 604800;
      var token = generateToken(expiry);
      log('管理员登录成功', 'INFO');
      res.json({ success: true, token: token });
    } catch (err) {
      log('POST /api/admin/auth 错误: ' + err.message, 'ERROR');
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/admin/key/status', function(req, res) {
    try {
      var pubKey = getPublicKey();
      if (pubKey) {
        res.json({ configured: true, fingerprint: getKeyFingerprint(pubKey) });
      } else {
        res.json({ configured: false });
      }
    } catch (err) {
      log('GET /api/admin/key/status 错误: ' + err.message, 'ERROR');
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/key/generate', function(req, res) {
    var pubKey = getPublicKey();
    if (pubKey) {
      return authenticateToken(req, res, function() {
        try {
          var keys = generateKeyPair();
          savePublicKey(keys.publicKey);
          log('新密钥对已生成（认证用户）', 'INFO');
          res.json({
            success: true,
            publicKey: keys.publicKey,
            privateKey: keys.privateKey,
            fingerprint: getKeyFingerprint(keys.publicKey)
          });
        } catch (err) {
          log('生成密钥失败: ' + err.message, 'ERROR');
          res.status(500).json({ success: false, message: err.message });
        }
      });
    } else {
      try {
        var keys = generateKeyPair();
        savePublicKey(keys.publicKey);
        log('首次初始化，新密钥对已生成', 'INFO');
        res.json({
          success: true,
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
          fingerprint: getKeyFingerprint(keys.publicKey)
        });
      } catch (err) {
        log('首次生成密钥失败: ' + err.message, 'ERROR');
        res.status(500).json({ success: false, message: err.message });
      }
    }
  });

  // ============================================================
  // ★★★ 需要认证的接口 ★★★
  // ============================================================

  app.get('/api/admin/files', authenticateToken, function(req, res) {
    try {
      var targetPath = req.query.path || '/';
      var realPath;
      if (targetPath === '/' || targetPath === '') {
        realPath = '/';
      } else {
        realPath = path.resolve(targetPath);
      }

      if (!fs.existsSync(realPath)) {
        return res.status(404).json({
          error: '路径不存在',
          currentPath: realPath,
          parentPath: null,
          files: []
        });
      }

      var stat = fs.statSync(realPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({
          error: '不是目录',
          currentPath: realPath,
          parentPath: null,
          files: []
        });
      }

      var result = listDirectory(realPath);
      if (result.error) {
        return res.status(500).json({ error: result.error, files: [] });
      }

      var parentPath = getParentDir(realPath);

      res.json({
        currentPath: realPath,
        parentPath: parentPath,
        files: result.files,
        isRoot: realPath === '/' || realPath === path.parse(realPath).root
      });
    } catch (err) {
      log('GET /api/admin/files 错误: ' + err.message, 'ERROR');
      res.status(500).json({ error: err.message, files: [] });
    }
  });

  app.post('/api/admin/files/upload', authenticateToken, function(req, res) {
    var targetDir = req.query.path || process.cwd();
    var realTargetDir;
    try {
      realTargetDir = path.resolve(targetDir);
      if (!fs.existsSync(realTargetDir)) {
        return res.status(400).json({
          success: false,
          message: '目标目录不存在: ' + targetDir
        });
      }
      var stat = fs.statSync(realTargetDir);
      if (!stat.isDirectory()) {
        return res.status(400).json({
          success: false,
          message: '目标路径不是目录: ' + targetDir
        });
      }
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: '无效的目标目录: ' + err.message
      });
    }

    req.query._targetDir = realTargetDir;
    handleFileUpload(req, res);
  });

  app.get('/api/admin/files/download', authenticateToken, function(req, res) {
    try {
      var filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }

      var realPath = path.resolve(filePath);
      if (!fs.existsSync(realPath)) {
        return res.status(404).json({ error: '文件不存在' });
      }

      var stat = fs.statSync(realPath);
      if (stat.isDirectory()) {
        return res.status(400).json({ error: '不能下载目录' });
      }

      res.download(realPath, path.basename(realPath), function(err) {
        if (err) {
          log('下载文件失败: ' + err.message, 'ERROR');
        }
      });
    } catch (err) {
      log('GET /api/admin/files/download 错误: ' + err.message, 'ERROR');
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/admin/files', authenticateToken, function(req, res) {
    try {
      var filePath = req.query.path;
      if (!filePath) {
        return res.status(400).json({ error: '缺少 path 参数' });
      }

      var realPath = path.resolve(filePath);
      if (!fs.existsSync(realPath)) {
        return res.status(404).json({ error: '文件不存在' });
      }

      var stat = fs.statSync(realPath);
      if (stat.isDirectory()) {
        var files = fs.readdirSync(realPath);
        if (files.length > 0) {
          return res.status(400).json({ error: '目录不为空，无法删除' });
        }
        fs.rmdirSync(realPath);
        log('目录删除成功: ' + filePath, 'INFO');
      } else {
        fs.unlinkSync(realPath);
        log('文件删除成功: ' + filePath, 'INFO');
      }

      res.json({ success: true });
    } catch (err) {
      log('DELETE /api/admin/files 错误: ' + err.message, 'ERROR');
      res.status(500).json({ error: err.message });
    }
  });

  // 终端命令执行
  var currentWorkingDir = '/';

  app.post('/api/admin/terminal/exec', authenticateToken, function(req, res) {
    var command = req.body.command;
    if (!command) {
      return res.status(400).json({ error: '缺少命令' });
    }

    var cdMatch = command.match(/^cd\s+(.+)$/);
    if (cdMatch) {
      var targetDir = cdMatch[1].trim();
      if (targetDir === '~') {
        targetDir = process.env.HOME || '/root';
      }
      var newPath = path.resolve(currentWorkingDir, targetDir);
      try {
        if (fs.existsSync(newPath)) {
          var stat = fs.statSync(newPath);
          if (stat.isDirectory()) {
            currentWorkingDir = newPath;
            return res.json({ output: '', cwd: currentWorkingDir });
          } else {
            return res.json({ output: '❌ 不是目录: ' + targetDir, cwd: currentWorkingDir });
          }
        } else {
          return res.json({ output: '❌ 目录不存在: ' + targetDir, cwd: currentWorkingDir });
        }
      } catch (err) {
        return res.json({ output: '❌ 无法访问: ' + targetDir, cwd: currentWorkingDir });
      }
    }

    var dangerous = ['rm -rf', 'mkfs', 'dd if=', ':(){:|:&};:', 'shutdown', 'reboot', 'halt', 'poweroff'];
    for (var i = 0; i < dangerous.length; i++) {
      if (command.indexOf(dangerous[i]) !== -1) {
        log('命令被阻止: ' + command, 'WARN');
        return res.status(403).json({ error: '命令被禁止: ' + dangerous[i] });
      }
    }

    try {
      var fullCommand = 'cd ' + currentWorkingDir + ' && ' + command;
      var output = execSync(fullCommand, {
        encoding: 'utf-8',
        timeout: 30000,
        shell: '/bin/bash',
        maxBuffer: 1024 * 1024 * 10
      });
      res.json({ output: output.trim() || '(无输出)', cwd: currentWorkingDir });
    } catch (err) {
      log('命令执行失败: ' + command + ' -> ' + err.message, 'WARN');
      res.json({
        output: '❌ 执行失败: ' + (err.stderr || err.message || '未知错误'),
        cwd: currentWorkingDir
      });
    }
  });

  // 性能监控
  app.get('/api/admin/status', authenticateToken, function(req, res) {
    try {
      var cpuData = getCpuUsage();
      var diskData = getDiskUsage();
      var networkData = getNetworkUsage();
      var cpuTemp = getCpuTemperature();
      var diskHealth = getDiskHealth();

      var totalMem = os.totalmem();
      var freeMem = os.freemem();
      var usedMem = totalMem - freeMem;

      var uptimeSeconds = process.uptime();

      res.json({
        cpu: {
          usage: cpuData.usage,
          loadavg: cpuData.loadavg
        },
        systemMemory: {
          totalGB: (totalMem / 1024 / 1024 / 1024).toFixed(1),
          usedGB: (usedMem / 1024 / 1024 / 1024).toFixed(1),
          usedPercent: Math.round((usedMem / totalMem) * 100)
        },
        cpuTemp: {
          temp: cpuTemp.temp,
          status: cpuTemp.status,
          updated: cpuTemp.updated
        },
        disk: {
          totalGB: diskData.totalGB,
          usedGB: diskData.usedGB,
          usedPercent: diskData.usedPercent
        },
        diskHealth: {
          health: diskHealth.health,
          status: diskHealth.status,
          usedGB: diskHealth.usedGB,
          totalGB: diskHealth.totalGB,
          powerOnHours: diskHealth.powerOnHours
        },
        network: {
          speed: networkData.speed,
          rx: networkData.rx,
          tx: networkData.tx
        },
        uptime: {
          human: formatUptime(uptimeSeconds),
          started: new Date(Date.now() - uptimeSeconds * 1000).toLocaleString()
        }
      });
    } catch (err) {
      log('GET /api/admin/status 错误: ' + err.message, 'ERROR');
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/system', authenticateToken, function(req, res) {
    try {
      res.json({
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime: formatUptime(process.uptime())
      });
    } catch (err) {
      log('GET /api/admin/system 错误: ' + err.message, 'ERROR');
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // ★★★ 静态资源托管（public 目录）★★★
  // ============================================================
  app.use(express.static(PUBLIC_DIR));
  app.use('/image', express.static(path.join(PROJECT_ROOT, 'image')));

  app.use(function(req, res) {
    res.status(404).json({ error: 'API 不存在' });
  });

  app.use(function(err, req, res, next) {
    log('全局错误: ' + err.message, 'ERROR');
    res.status(500).json({ error: '服务器内部错误' });
  });

  // ============================================================
  // ★★★ 启动服务（根据 httpsDecision 决定 HTTP 或 HTTPS）★★★
  // ============================================================
  try {
    var server;

    if (httpsDecision.enabled) {
      // ★★★ 启用 HTTPS ★★★
      var https = require('https');
      var options = {
        key: fs.readFileSync(httpsDecision.keyPath),
        cert: fs.readFileSync(httpsDecision.certPath)
      };
      server = https.createServer(options, app);
      log('HTTPS 服务器已创建，使用证书: ' + httpsDecision.keyPath, 'INFO');
    } else {
      // ★★★ 使用 HTTP ★★★
      server = app;
    }

    server.listen(adminPort, '0.0.0.0', function() {
      var protocol = httpsDecision.enabled ? 'https' : 'http';
      log(protocol.toUpperCase() + ' 管理后台已启动: ' + protocol + '://localhost:' + adminPort, 'INFO');
      log('管理配置: ' + ADMIN_CONFIG_PATH, 'INFO');
      log('访问: ' + protocol + '://localhost:' + adminPort + '/login.html', 'INFO');
      log('WebSocket 终端端点: ws://localhost:' + adminPort + '/terminal/ws?token=<token>', 'INFO');

      if (httpsDecision.enabled) {
        log('⚠️ HTTPS 已启用，请使用 HTTPS 访问', 'WARN');
        log('⚠️ 如使用自签名证书，浏览器会提示不安全，请点击"继续访问"', 'WARN');
      } else {
        log('⚠️ HTTPS 已禁用，使用 HTTP 访问', 'WARN');
      }
    });

    // WebSocket 服务器绑定到同一个服务器实例
    var wss = new WebSocket.Server({ server: server, path: '/terminal/ws' });

    wss.on('connection', function(ws, req) {
      var url = new URL(req.url, 'http://' + req.headers.host);
      var token = url.searchParams.get('token');

      if (!token) {
        ws.close(1008, '未提供 Token');
        return;
      }

      var payload = verifyToken(token);
      if (!payload) {
        ws.close(1008, 'Token 无效或已过期');
        return;
      }

      var sessionId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      log('终端 WebSocket 连接已建立: ' + sessionId, 'INFO');

      try {
        var shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
        var ptyProcess = pty.spawn(shell, [], {
          name: 'xterm-color',
          cols: 120,
          rows: 30,
          cwd: process.env.HOME || '/',
          env: process.env
        });

        ptyProcess.onData(function(data) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        });

        ws.on('message', function(message) {
          try {
            var data = message.toString();
            ptyProcess.write(data);
          } catch (err) {
            // ignore
          }
        });

        ws.on('close', function() {
          try {
            ptyProcess.kill();
          } catch (e) {}
          log('终端 WebSocket 已关闭: ' + sessionId, 'INFO');
        });

        ws.on('error', function(err) {
          log('终端 WebSocket 错误: ' + err.message, 'ERROR');
          try {
            ptyProcess.kill();
          } catch (e) {}
        });

      } catch (err) {
        log('创建 PTY 进程失败: ' + err.message, 'ERROR');
        ws.close(1011, 'PTY 创建失败');
      }
    });

    server.on('error', function(err) {
      log('服务启动错误: ' + err.message, 'ERROR');
    });

    return app;
  } catch (err) {
    log('管理服务启动失败: ' + err.message, 'ERROR');
    return null;
  }
}

module.exports = { createAdminServer };