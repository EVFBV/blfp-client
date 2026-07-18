const { exec } = require('child_process');
const net = require('net');

/**
 * 扫描当前所有 java 进程正在监听的 TCP 端口
 * Windows: 先找 java.exe PID，再用 netstat 查其监听端口
 * @returns {Promise<Array<{pid, port, process}>>}
 */
function scanJavaPorts() {
  return new Promise((resolve) => {
    // 先获取所有 java 进程 PID
    exec('tasklist /FI "IMAGENAME eq java.exe" /FO CSV /NH', (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);

      const javaPids = [];
      for (const line of stdout.split('\n')) {
        const parts = line.trim().replace(/"/g, '').split(',');
        if (parts.length >= 2) {
          const pid = parts[1]?.trim();
          if (pid && !isNaN(pid)) javaPids.push(pid);
        }
      }

      if (!javaPids.length) return resolve([]);

      // 查询这些 PID 的 TCP 监听端口
      exec('netstat -ano -p TCP', (err2, out2) => {
        if (err2) return resolve([]);

        const results = [];
        const seen = new Set();

        for (const line of out2.split('\n')) {
          const m = line.match(/\s+TCP\s+[\d.:]+:(\d+)\s+0\.0\.0\.0:0\s+LISTENING\s+(\d+)/i)
                 || line.match(/\s+TCP\s+[\d.:]+:(\d+)\s+\*:0\s+LISTENING\s+(\d+)/i)
                 || line.match(/TCP\s+0\.0\.0\.0:(\d+)\s+0\.0\.0\.0:0\s+LISTEN\s+(\d+)/i);
          if (m) {
            const port = parseInt(m[1]);
            const pid = m[2];
            if (javaPids.includes(pid) && !seen.has(port)) {
              seen.add(port);
              results.push({ pid, port, process: 'java.exe' });
            }
          }
        }

        // 25565 排在最前面
        results.sort((a, b) => {
          if (a.port === 25565) return -1;
          if (b.port === 25565) return 1;
          return a.port - b.port;
        });

        resolve(results);
      });
    });
  });
}

module.exports = { scanJavaPorts };
