// src/js/pages/tools.js — /tools page (index of available tools)
//
// The /tools route is the catalog: each card lists the tool's name,
// purpose, and what the user must provide + what comes back. Clicking a
// card opens that tool's detail page (registered under /tools/<id>).
//
// The first tool is the video frame-extractor, mounted at
// /tools/video-frames. Keeping tool markup, progress UI, and IPC wiring
// in a sibling file (./tool_video_frames.js) means the index stays
// dead-simple and adding more tools doesn't bloat this file.
import { escapeHtml } from '../api.js';
import { register } from '../router.js';

// Catalog. Add a new entry here when introducing a tool; the index
// renders off `tools` directly with no other wiring required. `id`
// doubles as the route slug (`/tools/<id>`).
const tools = [
  {
    id: 'video-frames',
    name: '视频拆帧',
    icon: '🎞️',
    purpose: '把本地视频按指定帧率逐帧导出为图片，再打包成 zip 下载。',
    input: '一个本地视频文件（mp4 / mov / mkv / webm / avi / m4v 等），加抽帧速率与输出格式 (PNG / JPG)。',
    output: '一份 zip 压缩包，内含按时间顺序编号的图片 (例如 frame_0001_200.png，序号 4 位 + 末尾是每帧间隔的毫秒数，所有图片共用同一值，例如 1 秒 5 帧时全部为 200，1 秒 10 帧时全部为 100)。',
  },
  {
    id: 'transparent-png',
    name: '图片去背景',
    icon: '✂️',
    purpose: '把图片的背景变透明：自动识别背景色并从图片四周向内填充，边界线以内的部分完整保留（含与背景同色的内部区域），边界线以外全部转为透明。',
    input: '一张本地图片 (png / jpg / bmp / webp 等)，可选「切割强度」与「边缘柔化」。',
    output: '一张透明背景的 PNG 图片，尺寸与原图一致，可直接保存使用。',
  },
];

function render() {
  const app = document.getElementById('app');
  const cards = tools.map((t) => `
    <a href="#/tools/${escapeHtml(t.id)}" class="card tool-card" data-tool-id="${escapeHtml(t.id)}">
      <div class="tool-card-head">
        <span class="tool-card-icon" aria-hidden="true">${escapeHtml(t.icon)}</span>
        <span class="tool-card-name">${escapeHtml(t.name)}</span>
        <span class="tool-card-cta">进入 ›</span>
      </div>
      <p class="tool-card-purpose">${escapeHtml(t.purpose)}</p>
      <dl class="tool-card-io">
        <div class="tool-card-io-row">
          <dt>输入</dt>
          <dd>${escapeHtml(t.input)}</dd>
        </div>
        <div class="tool-card-io-row">
          <dt>输出</dt>
          <dd>${escapeHtml(t.output)}</dd>
        </div>
      </dl>
    </a>
  `).join('');

  app.innerHTML = `
    <h1>工具</h1>
    <p class="meta">这里收集一些常用工具。点开任意卡片即可使用。所有处理都在本地完成，不会上传到任何服务器。</p>

    <div class="tool-list">
      ${cards || `<div class="empty">还没有工具，敬请期待。</div>`}
    </div>
  `;
}

register('/tools', render);
