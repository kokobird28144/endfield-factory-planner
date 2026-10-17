import { graph } from './graph.js';
import { recipes } from './recipes.js';
import { esc, iconImg } from './dom.js';
import { fmt as formatRate, parseSpeed } from './engine.js';
import { normalizeFlowRule } from './flowRules.js';
import { blueDrugExample } from './scanExample.js';
import { prepareScanAxes, gridRowIndex, gridSlice, nearestIndex } from './scanGrid.js';
import { drawHeatmap, heatGeometry } from './scanHeatmap.js';
import { scanMetrics, metricValue } from './scanMetrics.js';

let panel;
// Remove solver roundoff at half-cent boundaries, only for displayed values.
const fmt = value => formatRate(Number.isFinite(value) ? Number(value.toPrecision(12)) : value);
const numberInput = (value, attrs = '') => `<input type="number" min="0" step="any" value="${esc(value)}" ${attrs}>`;
const options = (entries, selected) => entries.map(([value, label]) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`).join('');
const clone = value => structuredClone(value);
const SERIES_COLORS = ['#48c9a4', '#f5c66f', '#70b7ff', '#f28b9e', '#c1a0f7', '#c9df7e', '#65d7e7', '#f1a16b'];

class SupplyScan {
  constructor() {
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'supplyScan';
    this.dialog.className = 'supply-scan';
    this.dialog.setAttribute('aria-labelledby', 'scanTitle');
    this.dialog.innerHTML = `
      <header class="scan-header"><h2 id="scanTitle">原料扫描 <small>实验</small></h2><button type="button" class="btn" data-close title="关闭" aria-label="关闭扫描">×</button></header>
      <div class="scan-body">
        <div class="scan-toolbar">
          <div class="scan-segments scan-dimensions" role="group" aria-label="扫描维度">
            <label><input type="radio" name="scan-dimension" value="1">单原料</label>
            <label><input type="radio" name="scan-dimension" value="2" checked>双原料</label>
          </div>
          <div class="scan-scope-controls">
            <span class="scan-scope-label">当前画布</span>
            <button type="button" class="btn" data-refresh title="重新读取当前画布，重置扫描参数" aria-label="刷新当前画布">↻</button>
          </div>
        </div>
        <details class="scan-setup" open><summary>扫描范围</summary><div class="scan-controls">
          <label class="scan-source"><span data-source-name>扫描输入</span><select data-source></select></label>
          <label>起点 /分${numberInput(0, 'data-min')}</label>
          <label>终点 /分${numberInput(150, 'data-max')}</label>
          <label>步长${numberInput(6, 'data-step')}</label>
          <button type="button" class="btn btn-primary" data-run>开始扫描</button>
          <button type="button" class="btn" data-cancel hidden>停止</button>
        </div>
        <div class="scan-controls scan-secondary" data-secondary hidden>
          <label class="scan-source">输入 B<select data-source-b></select></label>
          <label>起点 /分${numberInput(0, 'data-min-b')}</label>
          <label>终点 /分${numberInput(150, 'data-max-b')}</label>
          <label>步长${numberInput(6, 'data-step-b')}</label>
        </div></details>
        <details class="scan-config"><summary>产线参数（仅本次扫描）</summary><div data-config></div></details>
        <div class="scan-status" data-status role="status" aria-live="polite">待扫描</div>
        <section class="scan-result" hidden>
          <div class="scan-result-bar"><span data-chart-title>流量曲线 · /分</span>
            <div class="scan-segments" data-views role="group" aria-label="结果视图" hidden>
              <label><input type="radio" name="scan-view" value="heat" checked>二维分布</label>
              <label><input type="radio" name="scan-view" value="slice">切片曲线</label>
            </div><button type="button" class="btn" data-export title="导出扫描结果 CSV" aria-label="导出扫描结果 CSV">↓ CSV</button></div>
          <div class="scan-view-options" data-view-options hidden>
            <label data-heat-option>绘图指标<select data-heat-product></select></label>
            <label data-slice-option hidden>切片方向<select data-slice-axis><option value="0">固定 B，扫描 A</option><option value="1">固定 A，扫描 B</option></select></label>
            <span data-axis-caption></span>
          </div>
          <div class="scan-product-list" data-products role="group" aria-label="显示的产物曲线"></div>
          <details class="scan-rejections" data-rejections><summary>原料拒收</summary>
            <div class="scan-product-list" data-rejection-list role="group" aria-label="显示的原料拒收曲线"></div>
          </details>
          <div class="scan-chart-wrap"><canvas data-chart role="img" aria-label="原料供给与产物产量曲线"></canvas></div>
          <div class="scan-point"><label><span data-point-name>供给点</span><output data-point-label></output><input type="range" data-point min="0" step="1" value="0" aria-label="查看供给点"></label>
            <label data-point-b-wrap hidden><span data-point-b-name>供给</span><output data-point-b-label></output><input type="range" data-point-b min="0" step="1" value="0" aria-label="查看供给"></label>
            <div data-summary></div><button type="button" class="btn btn-primary" data-apply title="将当前选中的扫描点应用到画布" aria-label="应用当前扫描点">应用到画布</button></div>
          <details class="scan-detail"><summary>机器与连线明细</summary><div class="scan-tables"><section><h3>机器实际速度</h3><div class="scan-table-scroll"><table><thead><tr><th>机器</th><th>实际 / 最大</th><th>状态</th></tr></thead><tbody data-nodes></tbody></table></div></section>
          <section><h3>实际连线流量</h3><div class="scan-table-scroll"><table><thead><tr><th>路径</th><th>流量 /分</th></tr></thead><tbody data-edges></tbody></table></div></section></div></details>
        </section>
      </div>`;
    document.body.append(this.dialog);
    this.el('[data-close]').onclick = () => this.dialog.close();
    this.el('.scan-header').addEventListener('pointerdown', event => {
      if (event.target.closest('button, input, select, a')) return;
      const rect = this.dialog.getBoundingClientRect();
      this.dialog.style.left = `${rect.left}px`;
      this.dialog.style.top = `${rect.top}px`;
      this.dialog.style.transform = 'none';
      this._drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      this.el('.scan-header').setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    this.el('.scan-header').addEventListener('pointermove', event => {
      if (!this._drag) return;
      const nextLeft = Math.max(0, Math.min(window.innerWidth - this.dialog.offsetWidth,
        this._drag.left + event.clientX - this._drag.x));
      const nextTop = Math.max(0, Math.min(window.innerHeight - this.dialog.offsetHeight,
        this._drag.top + event.clientY - this._drag.y));
      this.dialog.style.left = `${nextLeft}px`;
      this.dialog.style.top = `${nextTop}px`;
    });
    const stopDrag = () => { this._drag = null; };
    this.el('.scan-header').addEventListener('pointerup', stopDrag);
    this.el('.scan-header').addEventListener('pointercancel', stopDrag);
    this.dialog.addEventListener('close', () => this.stop());
    this.dialog.addEventListener('keydown', e => e.stopPropagation());
    this.el('[data-refresh]').onclick = () => this.load();
    this.el('[data-source]').onchange = () => this.syncSources();
    this.el('[data-source-b]').onchange = () => this.syncSources();
    this.el('.scan-dimensions').onchange = () => {
      this.el('[data-secondary]').hidden = !this.isDual();
      this.el('[data-source-name]').textContent = this.isDual() ? '输入 A' : '扫描输入';
      this.el('.scan-setup').open = true;
      this.syncSources();
    };
    this.el('[data-run]').onclick = () => this.run();
    this.el('[data-cancel]').onclick = () => this.stop();
    this.el('[data-products]').onchange = () => { this.draw(); this.point(); };
    this.el('[data-rejection-list]').onchange = () => { this.draw(); this.point(); };
    this.el('[data-point]').oninput = () => { this.draw(); this.point(); };
    this.el('[data-point-b]').oninput = () => { this.draw(); this.point(); };
    this.el('[data-views]').onchange = () => this.updateView();
    this.el('[data-heat-product]').onchange = () => { this.draw(); this.point(); };
    this.el('[data-slice-axis]').onchange = () => { this.draw(); this.point(); };
    this.el('[data-export]').onclick = () => this.export();
    this.el('[data-apply]').onclick = () => this.applySelected();
    this.dialog.addEventListener('input', event => {
      if (event.target.closest('.scan-controls, .scan-config, .scan-dimensions') && this.rows) this.invalidate();
      if (event.target.hasAttribute('data-abundant')) this.syncSources();
    });
    this.resize = new ResizeObserver(() => { if (this.rows && this.dialog.open) this.draw(); });
    this.resize.observe(this.el('.scan-chart-wrap'));
    this.el('[data-chart]').onclick = event => {
      if (!this.rows?.length) return;
      const rect = event.target.getBoundingClientRect();
      if (this.isHeat()) {
        const g = heatGeometry(rect.width, rect.height);
        const fx = Math.max(0, Math.min(1, (event.clientX - rect.left - g.left) / g.width));
        const fy = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top - g.top) / g.height));
        [fx, fy].forEach((f, i) => {
          const values = this.runAxes[i].values;
          this.el(i ? '[data-point-b]' : '[data-point]').value = nearestIndex(values, values[0] + f * (values.at(-1) - values[0]));
        });
        this.draw(); this.point(); return;
      }
      const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - 55) / (rect.width - 75)));
      const axis = this.varyingAxis(), values = this.runAxes[axis].values;
      this.el(axis ? '[data-point-b]' : '[data-point]').value = nearestIndex(values, values[0] + fraction * (values.at(-1) - values[0]));
      this.draw(); this.point();
    };
  }

  el(selector) { return this.dialog.querySelector(selector); }
  isDual() { return this.el('[name="scan-dimension"]:checked').value === '2'; }
  isHeat() { return this.runAxes?.length === 2 && this.el('[name="scan-view"]:checked').value === 'heat'; }
  varyingAxis() { return this.runAxes?.length === 2 ? Number(this.el('[data-slice-axis]').value) : 0; }
  selectedRow() {
    return this.rows?.[gridRowIndex(Number(this.el('[data-point]').value), this.runAxes?.length === 2 ? Number(this.el('[data-point-b]').value) : 0, this.runAxes?.[0].values.length || 1)];
  }
  curveRows() { return gridSlice(this.rows, this.runAxes, Number(this.el('[data-point]').value), Number(this.el('[data-point-b]').value), this.varyingAxis()); }
  status(message) { this.el('[data-status]').textContent = message; }
  open() {
    // Non-modal scan panel: keep the editor usable while scanning.
    this.dialog.show();
    if (!this.model) this.load();
    else if (this.rows) this.draw();
  }
  busy(value) {
    this.dialog.querySelectorAll('.scan-controls input, .scan-controls select, .scan-config input, .scan-config select, .scan-dimensions input, [data-refresh], [data-run]').forEach(el => { el.disabled = value; });
    this.el('[data-cancel]').hidden = !value;
    if (!value && this.model) this.syncSources();
  }
  stop() {
    if (this.worker) { this.worker.terminate(); this.worker = null; this.status('扫描已停止'); }
    this.busy(false);
  }
  invalidate() {
    this.stop(); this.rows = null;
    this.el('.scan-result').hidden = true;
    this.status('参数已变更，待扫描');
  }
  load() {
    this.invalidate();
    this.el('.scan-setup').open = true;
    try {
      this.model = clone(graph.buildModel());
      this.model.nodes.forEach(n => {
        n.label ||= graph.state.get(String(n.id))?.label || n.id;
        n.maxSpeed = parseSpeed(n.maxSpeed ?? n.speed, 1);
      });
      this.model.edges = this.model.edges.map(e => ({ ...e, ...normalizeFlowRule(e), receivePriority: e.receivePriority || 1 }));
      this.sources = this.model.nodes.flatMap(n => n.type === 'source' ? n.outputPorts.map((p, i) => ({ node: n, port: i, item: p.item_id })) : []);
      this.el('[data-source]').innerHTML = options(this.sources.map((s, i) => [i, `${s.node.label} · ${recipes.itemName(s.item)} · ${s.port + 1}`]), 0);
      this.el('[data-source-b]').innerHTML = options(this.sources.map((s, i) => [i, `${s.node.label} · ${recipes.itemName(s.item)} · ${s.port + 1}`]), this.sources.length > 1 ? 1 : 0);
      this.config();
      this.el('[data-secondary]').hidden = !this.isDual();
      this.el('[data-source-name]').textContent = this.isDual() ? '输入 A' : '扫描输入';
      this.syncSources();
      this.status(this.sources.length ? '待扫描' : '当前产线没有固定源，请选择蓝药示例或添加原料源。');
    } catch (error) { this.model = null; this.el('[data-config]').innerHTML = ''; this.status(error.message); }
  }
  route(e) {
    const a = this.model.nodes.find(n => n.id === e.from), b = this.model.nodes.find(n => n.id === e.to);
    return `${a?.label || e.from} [${e.fromPort + 1}] → ${b?.label || e.to} [${e.toPort + 1}]`;
  }
  syncSources() {
    const selected = this.selectedSources();
    this.sources?.forEach((s, i) => {
      const supply = this.el(`[data-supply="${i}"]`), ample = this.el(`[data-abundant="${i}"]`);
      if (!supply || !ample) return;
      ample.disabled = selected.includes(i);
      supply.disabled = selected.includes(i) || ample.checked;
      supply.title = selected.includes(i) ? '由扫描范围决定' : ample.checked ? '按所有机器最大需求供给' : '固定供给量';
    });
  }
  selectedSources() { return [Number(this.el('[data-source]').value), ...(this.isDual() ? [Number(this.el('[data-source-b]').value)] : [])]; }
  config() {
    const machines = this.model.nodes.filter(n => n.type === 'machine');
    this.el('[data-config]').innerHTML = `
      <h3>原料供给</h3><div class="scan-table-scroll"><table><thead><tr><th>来源</th><th>供给 /分</th><th>充足供给</th></tr></thead><tbody>${this.sources.map((s, i) => `<tr><td>${iconImg(s.item, 'scan-item-icon')}${esc(s.node.label)} · ${esc(recipes.itemName(s.item))}</td><td>${numberInput(s.node.outputPorts[s.port].baseRate, `data-supply="${i}" aria-label="${esc(s.node.label)}供给"`)}</td><td><input type="checkbox" data-abundant="${i}" aria-label="${esc(s.node.label)}充足供给"${s.node.abundant?.includes(s.port) ? ' checked' : ''}></td></tr>`).join('')}</tbody></table></div>
      <h3>机器产能</h3><div class="scan-table-scroll"><table><thead><tr><th>机器</th><th>最大速度 ×</th><th>满速产出 /分</th></tr></thead><tbody>${machines.map((n, i) => `<tr><td>${esc(n.label)}</td><td>${numberInput(n.maxSpeed, `data-capacity="${i}" aria-label="${esc(n.label)}最大速度"`)}</td><td>${n.outputPorts.map(p => `${esc(recipes.itemName(p.item_id))} ${fmt(p.baseRate)} × 速度`).join('；')}</td></tr>`).join('')}</tbody></table></div>
      <h3>分流与汇流</h3><div class="scan-table-scroll"><table class="scan-edge-config"><thead><tr><th>路径</th><th>分流模式</th><th>权重 / 固定量 / 优先级</th><th>流量上限 /分</th><th>汇入优先级（1 最高）</th></tr></thead><tbody>${this.model.edges.map((e, i) => `<tr><td>${esc(this.route(e))}</td><td><select data-mode="${i}" aria-label="路径 ${i + 1} 模式">${options([['weight', '权重'], ['fixed', '固定目标'], ['priority', '优先级']], e.mode)}</select></td><td>${numberInput(e.mode === 'weight' ? e.weight : e.mode === 'fixed' ? e.fixedRate : e.priority, `data-rule="${i}" aria-label="路径 ${i + 1} 分配值"`)}</td><td>${numberInput(e.maxRate ?? '', `data-limit="${i}" placeholder="不限" aria-label="路径 ${i + 1} 流量上限"`)}</td><td>${numberInput(e.receivePriority, `data-receive="${i}" aria-label="路径 ${i + 1} 汇入优先级"`)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  readModel() {
    const model = clone(this.model);
    const read = (selector, optional = false) => {
      const field = this.el(selector), text = field.value.trim();
      if (optional && text === '') return null;
      const v = text === '' ? NaN : Number(text);
      if (!Number.isFinite(v) || v < 0) throw new Error('参数必须是非负有限数；流量上限可以留空。');
      return v;
    };
    this.sources.forEach((s, i) => {
      const n = model.nodes.find(n => n.id === s.node.id);
      if (!this.selectedSources().includes(i) && !this.el(`[data-abundant="${i}"]`).checked)
        n.outputPorts[s.port].baseRate = read(`[data-supply="${i}"]`);
      n.abundant = (n.abundant || []).filter(p => p !== s.port);
      if (this.el(`[data-abundant="${i}"]`).checked) n.abundant.push(s.port);
    });
    model.nodes.filter(n => n.type === 'machine').forEach((n, i) => { n.maxSpeed = read(`[data-capacity="${i}"]`); });
    model.edges.forEach((e, i) => {
      e.mode = this.el(`[data-mode="${i}"]`).value;
      const value = read(`[data-rule="${i}"]`);
      e[e.mode === 'weight' ? 'weight' : e.mode === 'fixed' ? 'fixedRate' : 'priority'] = value;
      e.maxRate = read(`[data-limit="${i}"]`, true);
      e.receivePriority = read(`[data-receive="${i}"]`);
      if (!Number.isSafeInteger(e.receivePriority) || e.receivePriority < 1 || e.mode === 'priority' && (!Number.isSafeInteger(e.priority) || e.priority < 1))
        throw new Error('优先级必须是大于等于 1 的整数。');
    });
    return model;
  }
  run() {
    this.invalidate();
    try {
      if (!this.model) throw new Error('没有可扫描的产线。');
      const model = this.readModel();
      this.runSources = this.selectedSources().map(i => this.sources[i]);
      if (this.runSources.some(s => !s)) throw new Error('请选择原料输入。');
      const axes = this.runSources.map((source, i) => {
        const values = ['min', 'max', 'step'].map(k => this.el(`[data-${k}${i ? '-b' : ''}]`).value.trim());
        const [min, max, step] = values.map(v => v === '' ? NaN : Number(v));
        return { sourceId: source.node.id, portIndex: source.port, item: source.item, min, max, step,
          name: this.runSources.filter(s => s.item === source.item).length > 1
            ? `${recipes.itemName(source.item)}（${source.node.label} · ${source.node.id} [${source.port + 1}]）`
            : recipes.itemName(source.item),
          chartName: this.runSources.filter(s => s.item === source.item).length > 1
            ? `${recipes.itemName(source.item)}（${source.node.id} [${source.port + 1}]）`
            : recipes.itemName(source.item),
          label: `${source.node.label} · ${recipes.itemName(source.item)} [${source.port + 1}]` };
      });
      this.runAxes = prepareScanAxes(model, axes);
      this.runSource = this.runSources[0]; this.runModel = model;
      const worker = new Worker(new URL('./scanWorker.js', import.meta.url), { type: 'module' });
      this.worker = worker;
      this.busy(true); this.status('计算中…');
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        if (data.type === 'ready') worker.postMessage({ model, axes });
        else if (data.type === 'progress') this.status(`计算中 ${data.completed} / ${data.total}`);
        else {
          worker.terminate(); this.worker = null; this.busy(false);
          if (data.type === 'error') this.status(data.message);
          else { this.runAxes = data.axes; this.results(data.rows); }
        }
      };
      worker.onerror = event => {
        if (this.worker !== worker) return;
        this.stop(); this.status(`扫描失败：${event.message}`);
      };
    } catch (error) { this.status(error.message); }
  }
  results(rows) {
    this.rows = rows;
    const invalid = rows.filter(r => !r.valid).length;
    this.status(`${rows.length} 个供给点 · ${rows.length - invalid} 个有效${invalid ? ` · ${invalid} 个未求得有效解（不计产量）` : ''}`);
    this.items = [...new Set(rows.flatMap(r => Object.keys(r.finalOutput)))].sort();
    this.metrics = scanMetrics(rows, this.runModel, id => recipes.itemName(id));
    this.metricByKey = new Map(this.metrics.map(m => [m.key, m]));
    const rejections = this.metrics.filter(m => m.kind === 'unused');
    this.el('[data-products]').innerHTML = this.items.map((id, i) => `<label class="scan-product" title="${esc(id)}">
      <input type="checkbox" data-product="${esc(id)}" checked>
      <span class="scan-swatch" style="border-color:${this.seriesColor(i)};border-top-style:${this.seriesDash(i).length ? 'dashed' : 'solid'}" aria-hidden="true"></span>
      <span class="scan-product-name">${esc(recipes.itemName(id))}</span><output data-product-value="${i}"></output></label>`).join('');
    this.el('.scan-result').hidden = false;
    this.el('[data-rejection-list]').innerHTML = rejections.map((m, i) => `<label class="scan-product" title="${esc(m.label)}">
      <input type="checkbox" data-rejection="${esc(m.key)}">
      <span class="scan-swatch" style="border-color:${this.seriesColor(this.items.length + i)};border-top-style:dashed" aria-hidden="true"></span>
      <span class="scan-product-name">${esc(m.label)}</span><output data-rejection-value="${i}"></output></label>`).join('');
    this.el('[data-heat-product]').innerHTML = `<optgroup label="产物产量">${options(this.items.map(id => [id, recipes.itemName(id)]), this.items[0])}</optgroup>
      <optgroup label="原料拒收">${options(rejections.map(m => [m.key, m.label]))}</optgroup>`;
    const slider = this.el('[data-point]'); slider.max = this.runAxes[0].values.length - 1; slider.value = slider.max;
    const sliderB = this.el('[data-point-b]'); sliderB.max = (this.runAxes[1]?.values.length || 1) - 1; sliderB.value = sliderB.max;
    this.el('[name="scan-view"][value="heat"]').checked = true;
    this.el('[data-slice-axis]').value = '0';
    this.el('.scan-detail').open = false;
    if (this.runAxes.length === 2) { this.el('.scan-setup').open = false; this.el('.scan-config').open = false; }
    this.updateView();
  }
  updateView() {
    const dual = this.runAxes?.length === 2, heat = this.isHeat();
    this.el('[data-views]').hidden = !dual;
    this.el('[data-chart-title]').hidden = dual;
    this.el('[data-view-options]').hidden = !dual;
    this.el('[data-heat-option]').hidden = !heat;
    this.el('[data-slice-option]').hidden = !dual || heat;
    this.el('[data-products]').hidden = heat;
    this.el('[data-rejections]').hidden = heat;
    this.el('[data-point-b-wrap]').hidden = !dual;
    this.runAxes.forEach((axis, i) => {
      this.el(i ? '[data-point-b-name]' : '[data-point-name]').textContent = `${axis.name}供给`;
      this.el(i ? '[data-point-b]' : '[data-point]').setAttribute('aria-label', `查看${axis.name}供给`);
    });
    if (dual) {
      this.el('[data-slice-axis]').innerHTML = options(this.runAxes.map((axis, i) =>
        [i, `固定${this.runAxes[1 - i].chartName}，扫描${axis.chartName}`]), this.varyingAxis());
    }
    this.el('.scan-chart-wrap').classList.toggle('is-heat', heat);
    this.el('[data-chart]').setAttribute('aria-label', `${this.runAxes.map(a => a.name).join('、')}供给与流量${heat ? '热力图' : '曲线'}`);
    this.draw(); this.point();
  }
  point() {
    const r = this.selectedRow();
    if (!r) return;
    const items = this.isHeat() ? this.items : this.visibleItems();
    const selectedMetric = this.metricByKey.get(this.el('[data-heat-product]').value);
    const rejections = this.metrics.filter(m => m.kind === 'unused');
    rejections.forEach((m, i) => {
      const value = metricValue(r, m);
      this.el(`[data-rejection-value="${i}"]`).textContent = value === null ? '—' : fmt(value);
    });
    this.items.forEach((id, i) => { this.el(`[data-product-value="${i}"]`).textContent = r.valid ? fmt(r.finalOutput[id] || 0) : '—'; });
    this.el('[data-point-label]').textContent = `${fmt(r.value)} /分`;
    this.el('[data-point-b-label]').textContent = `${fmt(r.valueB || 0)} /分`;
    if (this.runAxes.length === 2) {
      this.el('[data-axis-caption]').textContent = this.isHeat()
        ? `横轴：${this.runAxes[0].name} · 纵轴：${this.runAxes[1].name}`
        : `固定${this.runAxes[1 - this.varyingAxis()].name} = ${fmt(this.varyingAxis() ? r.value : r.valueB)}/分`;
    }
    if (!r.valid) {
      this.el('[data-summary]').textContent = r.reason === 'limit' ? '此点求解超时 · 未计产量'
        : `此点未求得有效解${Number.isFinite(r.constraintResidual) ? ` · 守恒残差 ${r.residual.toExponential(2)}` : ''}`;
    this.el('[data-nodes]').innerHTML = ''; this.el('[data-edges]').innerHTML = ''; return;
    }
    const source = r.sources[this.runSource.node.id]?.[this.runSource.port];
    const shown = this.isHeat() ? [...items, ...(selectedMetric?.kind === 'unused' ? [selectedMetric.key] : [])] : this.visibleMetrics();
    const productSummary = shown.map(key => {
      const metric = this.metricByKey.get(key), value = metricValue(r, metric);
      return `${metric.label} ${value === null ? '—' : fmt(value)}/分`;
    }).join(' · ') || '未选择产物或拒收曲线';
    const usage = this.runAxes.length === 1 ? `原料实耗 ${fmt(source?.used || 0)}/分 · 未接收 ${fmt(source?.unused || 0)}/分`
      : this.runSources.map((s, i) => {
        const v = r.sources[s.node.id]?.[s.port];
        return `${this.runAxes[i].name} 实耗 ${fmt(v?.used || 0)}/分，未接收 ${fmt(v?.unused || 0)}/分`;
      }).join(' · ');
    this.el('[data-summary]').textContent = `${productSummary} · ${usage}`;
    this.el('[data-nodes]').innerHTML = this.runModel.nodes.filter(n => n.type === 'machine').map(n => `<tr><td>${esc(n.label)}</td><td>${fmt(r.speeds[n.id])} / ${fmt(n.maxSpeed)}</td><td>${n.maxSpeed === 0 ? '禁用' : r.bottlenecks.includes(n.id) ? '达到产能上限' : r.speeds[n.id] < 1e-6 ? '停机' : '缺料 / 出口受限'}</td></tr>`).join('');
    this.el('[data-edges]').innerHTML = this.runModel.edges.map(e => `<tr><td>${esc(this.route(e))}</td><td>${fmt(r.flows[e.id])}</td></tr>`).join('');
  }
  visibleItems() { return [...this.dialog.querySelectorAll('[data-product]:checked')].map(el => el.dataset.product); }
  visibleMetrics() { return [...this.visibleItems(), ...[...this.dialog.querySelectorAll('[data-rejection]:checked')].map(el => el.dataset.rejection)]; }
  applySelected() {
    const result = this.selectedRow();
    if (!result?.valid) { this.status('当前点没有可应用的有效计算结果。'); return; }
    if (!this.runModel || !this.runSources?.length) { this.status('没有可应用的扫描结果。'); return; }
    try {
      const nodes = graph.serializeNodes();
      const edges = graph.serializeEdges();
      const nodeById = new Map(this.runModel.nodes.map(n => [String(n.id), n]));
      const currentToScan = new Map();
      nodes.forEach((node, index) => {
        const scanNode = this.runModel.nodes[index];
        if (scanNode) currentToScan.set(String(node.id), String(scanNode.id));
      });
      for (const node of nodes) {
        const scanned = nodeById.get(currentToScan.get(String(node.id)));
        if (!scanned) continue;
        if (scanned.type === 'source') {
          const sourceResult = result.sources[String(node.id)];
          const outputs = Array.isArray(node.source_outputs) ? node.source_outputs : [];
          scanned.outputPorts.forEach((port, index) => {
            const current = outputs[index] || { item_id: port.item_id, rate: port.baseRate };
            const scannedAxis = this.runAxes.find(axis =>
              axis.item === port.item_id &&
              axis.portIndex === index &&
              String(axis.sourceId) === String(scanned.id));
            const value = scannedAxis
              ? (this.runAxes.indexOf(scannedAxis) === 0 ? result.value : result.valueB)
              : port.baseRate;
            if (outputs[index]) outputs[index].rate = String(value);
            else outputs[index] = { item_id: port.item_id, rate: String(value) };
          });
          node.source_outputs = outputs;
          node.source_item = outputs[0]?.item_id || '';
          node.source_rate = outputs[0]?.rate || '0';
          node.abundant = scanned.abundant || [];
        } else if (scanned.type === 'machine') {
          node.speed = String(result.speeds[scanned.id] ?? scanned.maxSpeed ?? scanned.speed);
          node.auto_slow = false;
        }
      }
      const scannedEdges = new Map(this.runModel.edges.map(e => [String(e.id), e]));
      edges.forEach(edge => {
        const scanFrom = currentToScan.get(String(edge.from));
        const scanTo = currentToScan.get(String(edge.to));
        const scanned = this.runModel.edges.find(e =>
          String(e.from) === scanFrom && String(e.to) === scanTo &&
          Number(e.fromPort) === Number(edge.fromPort) && Number(e.toPort) === Number(edge.toPort));
        if (!scanned) return;
        edge.mode = scanned.mode;
        edge.weight = scanned.weight;
        edge.fixedRate = scanned.fixedRate;
        edge.priority = scanned.priority;
        edge.maxRate = scanned.maxRate ?? null;
        edge.receivePriority = scanned.receivePriority;
      });
      graph.loadFromNodesEdges(nodes, edges, graph.serializeBoards());
      graph.resetHistory();
      // Keep the completed scan grid available for applying another point.
      // Refresh only the backing model so a later scan starts from this canvas.
      this.model = clone(graph.buildModel());
      this.model.nodes.forEach(n => {
        n.label ||= graph.state.get(String(n.id))?.label || n.id;
        n.maxSpeed = parseSpeed(n.maxSpeed ?? n.speed, 1);
      });
      this.model.edges = this.model.edges.map(e => ({ ...e, ...normalizeFlowRule(e), receivePriority: e.receivePriority || 1 }));
      this._scanCanvasNodeMap = new Map(
        graph.serializeNodes().map((node, index) => [String(node.id), String(this.runModel.nodes[index]?.id)])
      );
      this.status(`已应用 ${this.runAxes.map((axis, i) => `${axis.name} ${fmt(i ? result.valueB : result.value)}/分`).join('、')}，画布已重新配平。`);
    } catch (error) {
      this.status(`应用失败：${error.message}`);
    }
  }
  seriesColor(index) { return SERIES_COLORS[index % SERIES_COLORS.length]; }
  seriesDash(index) { return this.metrics?.[index]?.kind === 'unused' ? [6, 4] : index < SERIES_COLORS.length ? [] : [4 + 3 * Math.floor(index / SERIES_COLORS.length), 4]; }
  draw() {
    if (!this.rows?.length || this.el('.scan-result').hidden) return;
    const canvas = this.el('[data-chart]'), rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1, w = rect.width, h = rect.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.fillStyle = '#11191c'; ctx.fillRect(0, 0, w, h);
    if (this.isHeat()) {
      drawHeatmap(ctx, w, h, this.rows, this.runAxes, this.metricByKey.get(this.el('[data-heat-product]').value),
        Number(this.el('[data-point]').value), Number(this.el('[data-point-b]').value));
      return;
    }
    const rows = this.curveRows(), varying = this.varyingAxis();
    const coordinate = r => varying ? r.valueB : r.value;
    const items = this.visibleMetrics();
    const x0 = coordinate(rows[0]), x1 = coordinate(rows.at(-1));
    const y1 = rows.reduce((max, r) => items.reduce((v, id) => Math.max(v, metricValue(r, this.metricByKey.get(id)) ?? 0), max), 1) * 1.1;
    const x = v => 55 + (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0)) * (w - 75);
    const y = v => h - 40 - v / y1 * (h - 70);
    ctx.font = '12px sans-serif'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const yy = y(y1 * i / 4);
      ctx.strokeStyle = '#344346'; ctx.beginPath(); ctx.moveTo(55, yy); ctx.lineTo(w - 20, yy); ctx.stroke();
      ctx.fillStyle = '#bdc8cb'; ctx.textAlign = 'right'; ctx.fillText(fmt(y1 * i / 4), 45, yy);
      const v = x0 + (x1 - x0) * i / 4;
      if (x1 !== x0 || i === 2) { ctx.textAlign = 'center'; ctx.fillText(fmt(v), x(v), h - 23); }
    }
    ctx.textAlign = 'left'; ctx.fillText('流量 /分', 12, 14);
    ctx.textAlign = 'right'; ctx.fillText(`${this.runAxes[varying].chartName}供给 /分`, w - 20, 14, Math.max(1, w - 110));
    const selected = this.selectedRow();
    for (const item of items) {
      const metric = this.metricByKey.get(item), index = this.metrics.indexOf(metric);
      ctx.strokeStyle = this.seriesColor(index); ctx.lineWidth = 2.5; ctx.setLineDash(this.seriesDash(index)); ctx.beginPath();
      let start = true;
      for (const r of rows) {
        const value = metricValue(r, metric);
        if (value === null) { start = true; continue; }
        if (start) ctx.moveTo(x(coordinate(r)), y(value));
        else ctx.lineTo(x(coordinate(r)), y(value));
        start = false;
      }
      ctx.stroke(); ctx.setLineDash([]);
      const selectedValue = metricValue(selected, metric);
      if (selectedValue !== null) {
        ctx.fillStyle = this.seriesColor(index); ctx.beginPath(); ctx.arc(x(coordinate(selected)), y(selectedValue), 4, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (!items.length) { ctx.fillStyle = '#bdc8cb'; ctx.textAlign = 'center'; ctx.fillText('未选择曲线', w / 2, h / 2); }
  }
  export() {
    if (!this.rows) return;
    const items = [...new Set(this.rows.flatMap(r => Object.keys(r.finalOutput)))];
    const dual = this.runAxes.length === 2;
    const otherRejections = this.metrics.filter(m => m.kind === 'unused' &&
      !this.runAxes.some(a => a.sourceId === m.sourceId && a.portIndex === m.portIndex));
    const headers = [...(dual ? this.runAxes.map(a => `${a.name} 供给/分`) : ['供给/分']), '状态',
      ...(dual ? this.runAxes.flatMap(a => [`${a.name} 实际消耗/分`, `${a.name} 未接收/分`]) : ['实际消耗/分', '未接收/分']),
      ...items.map(id => `${recipes.itemName(id)} (${id}) /分`), ...otherRejections.map(m => `${m.label}/分`)];
    const lines = [headers, ...this.rows.map(r => {
      const usage = this.runSources.flatMap(source => {
        const s = r.sources[source.node.id]?.[source.port];
        return [r.valid ? s?.used : '', r.valid ? s?.unused : ''];
      });
      return [r.value, ...(dual ? [r.valueB] : []), r.valid ? '有效' : r.reason === 'limit' ? '求解超时' : '未求得有效解', ...usage, ...items.map(id => r.valid ? r.finalOutput[id] || 0 : ''),
        ...otherRejections.map(m => metricValue(r, m) ?? '')];
    })];
    const csv = lines.map(row => row.map(v => {
      const text = String(v ?? '');
      return `"${(/^[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
    }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'supply-scan.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function openSupplyScan() {
  panel ||= new SupplyScan();
  panel.open();
}
