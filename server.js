// server.js - 项目主入口
// 功能：加载并启动管理服务

const { createAdminServer } = require('./adminserver.js');

// 捕获未处理的异常，防止进程崩溃
process.on('uncaughtException', (err) => {
  console.error('[FATAL] 未捕获的异常:', err.message);
  console.error(err.stack);
  // 不退出，让服务继续运行（但可能是严重错误，建议根据情况决定是否退出）
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] 未处理的 Promise 拒绝:', reason);
});

console.log('[BOOT] 正在启动 MinecraftSniper 管理服务...');

// 启动管理服务
const app = createAdminServer();

if (!app) {
  console.error('[BOOT] ❌ 管理服务启动失败，请检查日志');
  process.exit(1);
} else {
  console.log('[BOOT] ✅ 管理服务已启动，等待请求...');
}

// 导出 app 以便测试或其他模块使用（可选）
module.exports = app;