/**
 * Dashboard client: public overview + token-protected operator tools (Sheets + pipeline + LLM regen).
 */

(function () {
  const API_BASE = '/api/dashboard';
  const TOKEN_KEY = 'deatonDashboardToken';

  /** @type {{ summary: object, contacts: object[], intelligence: object[], companyProfiles: object[], reviewQueue: object[] } | null} */
  let snapshot = null;

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(value) {
    const v = value.trim();
    if (v) sessionStorage.setItem(TOKEN_KEY, v);
    else sessionStorage.removeItem(TOKEN_KEY);
  }

  /** @param {Record<string, number>} counts */
  function sortedEntries(counts) {
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  /** @param {Record<string, number>} counts */
  function renderBars(counts) {
    const entries = sortedEntries(counts);
    if (entries.length === 0) return '<p class="muted">No rows.</p>';
    const max = Math.max(...entries.map(([, n]) => n), 1);
    const rows = entries
      .map(
        ([label, n]) => `
        <div class="bar-row">
          <span class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
          <div class="bar-track" role="presentation">
            <div class="bar-fill" style="width:${(n / max) * 100}%"></div>
          </div>
          <span class="bar-count">${n}</span>
        </div>`,
      )
      .join('');
    return `<div class="bar-list">${rows}</div>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setLoading(isLoading) {
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = isLoading ? 'Working…' : '';
    el.classList.toggle('loading', isLoading);
  }

  function showError(msg) {
    const el = document.getElementById('error');
    if (!el) return;
    el.hidden = false;
    el.textContent = msg;
  }

  function clearError() {
    const el = document.getElementById('error');
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  function setTokenStatus(msg) {
    const el = document.getElementById('token-status');
    if (el) el.textContent = msg || '';
  }

  /**
   * @param {string} path
   * @param {RequestInit} [init]
   */
  async function api(path, init) {
    const headers = { ...(init && init.headers) };
    const t = getToken().trim();
    if (t) headers['X-Dashboard-Token'] = t;
    if (init && init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(API_BASE + path, { ...init, headers });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = json.error || json.hint || json.detail || text || res.statusText;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return json;
  }

  async function loadOverview() {
    setLoading(true);
    clearError();
    try {
      const data = await api('/summary', { method: 'GET' });
      const gen = document.getElementById('generated-at');
      if (gen) gen.textContent = new Date(data.generatedAt).toLocaleString();
      const c = data.contacts;
      document.getElementById('metric-contacts-total').textContent = String(c.total);
      document.getElementById('metric-contacts-url').textContent = String(c.withCompanyUrl);
      document.getElementById('breakdown-contacts').innerHTML = renderBars(c.pipelineStatus);
      const ci = data.companyIntelligence;
      document.getElementById('metric-intel-total').textContent = String(ci.total);
      document.getElementById('metric-intel-errors').textContent = String(ci.errorCount);
      document.getElementById('breakdown-intel').innerHTML = renderBars(ci.pipelineStatus);
      const errBody = document.getElementById('intel-errors-body');
      if (errBody) {
        if (!ci.errors || ci.errors.length === 0) {
          errBody.innerHTML = '<tr><td colspan="2" class="muted">No errors logged.</td></tr>';
        } else {
          errBody.innerHTML = ci.errors
            .map(
              (row) =>
                `<tr><td>${escapeHtml(row.contactEmail)}</td><td class="mono">${escapeHtml(row.preview)}</td></tr>`,
            )
            .join('');
        }
      }
      const cp = data.companyProfiles;
      document.getElementById('metric-profiles-total').textContent = String(cp.total);
      document.getElementById('metric-profiles-errors').textContent = String(cp.errorCount);
      document.getElementById('breakdown-profiles').innerHTML = renderBars(cp.pipelineStatus);
      const perrBody = document.getElementById('profile-errors-body');
      if (perrBody) {
        if (!cp.errors || cp.errors.length === 0) {
          perrBody.innerHTML = '<tr><td colspan="2" class="muted">No profile errors logged.</td></tr>';
        } else {
          perrBody.innerHTML = cp.errors
            .map(
              (row) =>
                `<tr><td class="mono">${escapeHtml(row.canonicalUrl)}</td><td class="mono">${escapeHtml(row.preview)}</td></tr>`,
            )
            .join('');
        }
      }
      const rq = data.reviewQueue;
      document.getElementById('metric-queue-total').textContent = String(rq.total);
      document.getElementById('breakdown-queue').innerHTML = renderBars(rq.status);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadSnapshot() {
    if (!getToken().trim()) {
      setTokenStatus('Save a token first to load operator data.');
      throw new Error('Missing dashboard token');
    }
    setLoading(true);
    clearError();
    try {
      snapshot = await api('/snapshot', { method: 'GET' });
      setTokenStatus('Token accepted — snapshot loaded.');
      return snapshot;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showError(msg);
      setTokenStatus(msg);
      throw e;
    } finally {
      setLoading(false);
    }
  }

  function renderReviewQueue() {
    const mount = document.getElementById('queue-mount');
    if (!mount || !snapshot) return;
    const q = snapshot.reviewQueue;
    mount.innerHTML = q
      .map(
        (e) => `
      <details class="rq-row" data-row="${e._rowIndex}">
        <summary>
          <span class="badge">${e._rowIndex}</span>
          <strong>${escapeHtml(e.contactEmail)}</strong>
          · step ${e.stepNumber}
          · <span class="status-tag">${escapeHtml(e.status || '')}</span>
          <span class="subj">${escapeHtml((e.subject || '').slice(0, 72))}</span>
        </summary>
        <div class="rq-detail">
          <label>Subject <input class="rq-subject" type="text" value="${escapeHtml(e.subject || '')}" /></label>
          <label>Body <textarea class="rq-body" rows="8">${escapeHtml(e.body || '')}</textarea></label>
          <label>Dave notes (saved to sheet; also used as regen input if non-empty) <textarea class="rq-dave" rows="3">${escapeHtml(e.daveNotes || '')}</textarea></label>
          <label>Reviewer notes <textarea class="rq-notes" rows="4">${escapeHtml(e.reviewerNotes || '')}</textarea></label>
          <label>Status <input class="rq-status" type="text" value="${escapeHtml(e.status || '')}" /></label>
          <div class="btn-row">
            <button type="button" data-act="save-rq">Save row</button>
            <button type="button" data-act="append-rq">Append reviewer note</button>
            <button type="button" data-act="regen-rq">Regenerate (LLM)</button>
            <button type="button" data-act="del-rq" class="danger">Delete row</button>
          </div>
        </div>
      </details>`,
      )
      .join('');
  }

  function renderContacts() {
    const mount = document.getElementById('contacts-mount');
    if (!mount || !snapshot) return;
    const list = snapshot.contacts;
    mount.innerHTML = list
      .map(
        (c) => `
      <details class="c-row" data-email="${escapeHtml(c.email)}" data-row="${c._rowIndex}">
        <summary>
          <strong>${escapeHtml(c.email)}</strong>
          · ${escapeHtml(c.company || '')}
          · <span class="status-tag">${escapeHtml(c.pipelineStatus || '')}</span>
        </summary>
        <div class="c-detail">
          <label>First <input class="c-first" type="text" value="${escapeHtml(c.firstName || '')}" /></label>
          <label>Last <input class="c-last" type="text" value="${escapeHtml(c.lastName || '')}" /></label>
          <label>Company <input class="c-company" type="text" value="${escapeHtml(c.company || '')}" /></label>
          <label>Title <input class="c-title" type="text" value="${escapeHtml(c.title || '')}" /></label>
          <label>Campaign id <input class="c-camp" type="text" value="${escapeHtml(c.campaignId || '')}" /></label>
          <label>Company URL <input class="c-url" type="text" value="${escapeHtml(c.companyUrl || '')}" /></label>
          <label>Pipeline status <input class="c-pipe" type="text" value="${escapeHtml(c.pipelineStatus || '')}" /></label>
          <label>Contact status <input class="c-st" type="text" value="${escapeHtml(c.status || '')}" /></label>
          <label>Notes <textarea class="c-notes" rows="3">${escapeHtml(c.notes || '')}</textarea></label>
          <div class="btn-row">
            <button type="button" data-act="save-c">Save contact</button>
            <button type="button" data-act="pipe-c">Run pipeline for this email</button>
          </div>
        </div>
      </details>`,
      )
      .join('');
  }

  function renderIntel() {
    const mount = document.getElementById('intel-mount');
    if (!mount || !snapshot) return;
    const list = snapshot.intelligence;
    if (!list || list.length === 0) {
      mount.innerHTML =
        '<p class="muted">No Company intelligence rows yet (pipeline creates one per contact when enabled).</p>';
      return;
    }
    mount.innerHTML = list
      .map(
        (r) => `
      <details class="i-row" data-row="${r._rowIndex}">
        <summary>
          <span class="badge">${r._rowIndex}</span>
          <strong>${escapeHtml(r.contactEmail)}</strong>
          · <span class="status-tag">${escapeHtml(r.pipelineStatus || '')}</span>
          ${r.canonicalCompanyUrl ? `<span class="subj mono" title="Join key">${escapeHtml((r.canonicalCompanyUrl || '').slice(0, 36))}</span>` : ''}
          ${r.errorLog ? `<span class="subj mono">${escapeHtml((r.errorLog || '').slice(0, 64))}</span>` : ''}
        </summary>
        <div class="i-detail">
          <label>Canonical company URL (→ Company profiles col A) <input class="i-canon" type="text" value="${escapeHtml(r.canonicalCompanyUrl || '')}" /></label>
          <label>Company URL (Contacts copy) <input class="i-curl" type="text" value="${escapeHtml(r.companyUrl || '')}" /></label>
          <label>Pipeline status <input class="i-pipe" type="text" value="${escapeHtml(r.pipelineStatus || '')}" /></label>
          <label>Generated date <input class="i-gen" type="text" value="${escapeHtml(r.generatedDate || '')}" /></label>
          <label>David project notes <textarea class="i-david" rows="4">${escapeHtml(r.davidProjectNotes || '')}</textarea></label>
          <label>Executive brief <textarea class="i-brief" rows="4">${escapeHtml(r.executiveBrief || '')}</textarea></label>
          <label>Error log <textarea class="i-err" rows="3">${escapeHtml(r.errorLog || '')}</textarea></label>
          <div class="btn-row">
            <button type="button" data-act="save-i">Save intelligence row</button>
          </div>
        </div>
      </details>`,
      )
      .join('');
  }

  function renderProfiles() {
    const mount = document.getElementById('profiles-mount');
    if (!mount || !snapshot) return;
    const list = snapshot.companyProfiles || [];
    if (list.length === 0) {
      mount.innerHTML = '<p class="muted">No company profile rows (add the <strong>Company Profiles</strong> tab to the sheet or run <code>setup-sheets</code>).</p>';
      return;
    }
    mount.innerHTML = list
      .map(
        (r) => `
      <details class="p-row" data-row="${r._rowIndex}">
        <summary>
          <span class="badge">${r._rowIndex}</span>
          <span class="mono" title="${escapeHtml(r.canonicalCompanyUrl)}">${escapeHtml((r.canonicalCompanyUrl || '').slice(0, 52))}</span>
          · <span class="status-tag">${escapeHtml(r.pipelineStatus || '')}</span>
          <span class="subj">${escapeHtml((r.companyName || '').slice(0, 48))}</span>
        </summary>
        <div class="p-detail">
          <p class="muted small">Column A (canonical) is read-only here: <code>${escapeHtml(r.canonicalCompanyUrl || '')}</code></p>
          <label>Display company URL <input class="p-url" type="text" value="${escapeHtml(r.companyUrl || '')}" /></label>
          <label>Company name <input class="p-name" type="text" value="${escapeHtml(r.companyName || '')}" /></label>
          <label>Industry <input class="p-ind" type="text" value="${escapeHtml(r.industry || '')}" /></label>
          <label>Product summary <textarea class="p-prod" rows="3">${escapeHtml(r.productSummary || '')}</textarea></label>
          <label>Company size <input class="p-size" type="text" value="${escapeHtml(r.companySize || '')}" /></label>
          <label>Signals <textarea class="p-sig" rows="4">${escapeHtml(r.signals || '')}</textarea></label>
          <label>Signal summary <textarea class="p-sigs" rows="3">${escapeHtml(r.signalSummary || '')}</textarea></label>
          <label>Deaton capabilities matched <textarea class="p-cap" rows="3">${escapeHtml(r.deatonCapabilitiesMatched || '')}</textarea></label>
          <label>Case studies selected <textarea class="p-cases" rows="3">${escapeHtml(r.caseStudiesSelected || '')}</textarea></label>
          <label>Alignment rationale <textarea class="p-align" rows="3">${escapeHtml(r.alignmentRationale || '')}</textarea></label>
          <label>Confidence score <input class="p-conf" type="text" value="${escapeHtml(r.confidenceScore || '')}" /></label>
          <label>Pipeline status <input class="p-pipe" type="text" value="${escapeHtml(r.pipelineStatus || '')}" /></label>
          <label>Researched date <input class="p-res" type="text" value="${escapeHtml(r.researchedDate || '')}" /></label>
          <label>Last refreshed at <input class="p-lref" type="text" value="${escapeHtml(r.lastRefreshedAt || '')}" /></label>
          <label>Profile version <input class="p-ver" type="text" value="${escapeHtml(r.profileVersion || '')}" /></label>
          <label>Error log <textarea class="p-err" rows="3">${escapeHtml(r.errorLog || '')}</textarea></label>
          <div class="btn-row">
            <button type="button" data-act="save-p">Save profile row</button>
          </div>
        </div>
      </details>`,
      )
      .join('');
  }

  async function reloadOperatorTables() {
    await loadSnapshot();
    renderReviewQueue();
    renderContacts();
    renderIntel();
    renderProfiles();
  }

  document.getElementById('save-token')?.addEventListener('click', () => {
    const input = document.getElementById('dashboard-token');
    const v = input && 'value' in input ? input.value : '';
    setToken(v);
    setTokenStatus(getToken() ? 'Token saved for this tab.' : 'Token cleared.');
    snapshot = null;
  });

  document.getElementById('clear-token')?.addEventListener('click', () => {
    setToken('');
    const input = document.getElementById('dashboard-token');
    if (input && 'value' in input) input.value = '';
    setTokenStatus('Token cleared.');
    snapshot = null;
  });

  document.getElementById('refresh-overview')?.addEventListener('click', () => {
    void loadOverview();
  });

  document.getElementById('reload-queue')?.addEventListener('click', () => {
    void reloadOperatorTables().catch(() => {});
  });
  document.getElementById('reload-contacts')?.addEventListener('click', () => {
    void reloadOperatorTables().catch(() => {});
  });
  document.getElementById('reload-intel')?.addEventListener('click', () => {
    void reloadOperatorTables().catch(() => {});
  });
  document.getElementById('reload-profiles')?.addEventListener('click', () => {
    void reloadOperatorTables().catch(() => {});
  });

  /** @param {string} tab */
  function activateTab(tab) {
    document.querySelectorAll('.tab').forEach((btn) => {
      const on = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      const id = p.getAttribute('data-panel');
      p.classList.toggle('hidden', id !== tab);
    });
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (!tab) return;
      activateTab(tab);
      if (tab === 'overview') void loadOverview();
      if (tab === 'queue' || tab === 'contacts' || tab === 'intel' || tab === 'profiles') {
        void reloadOperatorTables().catch((e) => {
          showError(e instanceof Error ? e.message : String(e));
        });
      }
    });
  });

  document.getElementById('queue-mount')?.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const act = t.getAttribute('data-act');
    if (!act) return;
    const rowEl = t.closest('.rq-row');
    if (!(rowEl instanceof HTMLElement)) return;
    const rowIndex = parseInt(rowEl.getAttribute('data-row') || '', 10);
    void handleQueueAction(act, rowIndex, rowEl);
  });

  async function handleQueueAction(act, rowIndex, rowEl) {
    clearError();
    try {
      if (act === 'save-rq') {
        const body = {
          subject: rowEl.querySelector('.rq-subject')?.value ?? '',
          body: rowEl.querySelector('.rq-body')?.value ?? '',
          daveNotes: rowEl.querySelector('.rq-dave')?.value ?? '',
          reviewerNotes: rowEl.querySelector('.rq-notes')?.value ?? '',
          status: rowEl.querySelector('.rq-status')?.value ?? '',
        };
        await api(`/review-queue/${rowIndex}`, { method: 'PATCH', body: JSON.stringify(body) });
        await reloadOperatorTables();
        activateTab('queue');
      } else if (act === 'append-rq') {
        const text = window.prompt('Text to append to reviewer notes');
        if (!text) return;
        await api(`/review-queue/${rowIndex}/notes/append`, { method: 'POST', body: JSON.stringify({ text }) });
        await reloadOperatorTables();
        activateTab('queue');
      } else if (act === 'regen-rq') {
        const ta = rowEl.querySelector('.rq-dave');
        const override = ta && 'value' in ta ? ta.value.trim() : '';
        const body = override ? JSON.stringify({ daveNotes: override }) : '{}';
        setLoading(true);
        await api(`/review-queue/${rowIndex}/regenerate`, { method: 'POST', body });
        await reloadOperatorTables();
        activateTab('queue');
      } else if (act === 'del-rq') {
        if (!window.confirm(`Delete Review Queue sheet row ${rowIndex}? This cannot be undone.`)) return;
        await api(`/review-queue/${rowIndex}`, { method: 'DELETE' });
        await reloadOperatorTables();
        activateTab('queue');
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  document.getElementById('contacts-mount')?.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const act = t.getAttribute('data-act');
    if (!act) return;
    const rowEl = t.closest('.c-row');
    if (!(rowEl instanceof HTMLElement)) return;
    const email = rowEl.getAttribute('data-email') || '';
    void handleContactAction(act, email, rowEl);
  });

  async function handleContactAction(act, email, rowEl) {
    clearError();
    try {
      if (act === 'save-c') {
        const updates = {
          firstName: rowEl.querySelector('.c-first')?.value ?? '',
          lastName: rowEl.querySelector('.c-last')?.value ?? '',
          company: rowEl.querySelector('.c-company')?.value ?? '',
          title: rowEl.querySelector('.c-title')?.value ?? '',
          campaignId: rowEl.querySelector('.c-camp')?.value ?? '',
          companyUrl: rowEl.querySelector('.c-url')?.value ?? '',
          pipelineStatus: rowEl.querySelector('.c-pipe')?.value ?? '',
          status: rowEl.querySelector('.c-st')?.value ?? '',
          notes: rowEl.querySelector('.c-notes')?.value ?? '',
        };
        await api('/contacts', { method: 'PATCH', body: JSON.stringify({ email, updates }) });
        await reloadOperatorTables();
        activateTab('contacts');
      } else if (act === 'pipe-c') {
        setLoading(true);
        await api('/pipeline/run-contact', { method: 'POST', body: JSON.stringify({ email, reset: 'auto' }) });
        await reloadOperatorTables();
        void loadOverview();
        activateTab('contacts');
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  document.getElementById('intel-mount')?.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const act = t.getAttribute('data-act');
    if (act !== 'save-i') return;
    const rowEl = t.closest('.i-row');
    if (!(rowEl instanceof HTMLElement)) return;
    const rowIndex = parseInt(rowEl.getAttribute('data-row') || '', 10);
    void handleIntelSave(rowIndex, rowEl);
  });

  async function handleIntelSave(rowIndex, rowEl) {
    clearError();
    setLoading(true);
    try {
      const body = {
        canonicalCompanyUrl: rowEl.querySelector('.i-canon')?.value ?? '',
        companyUrl: rowEl.querySelector('.i-curl')?.value ?? '',
        pipelineStatus: rowEl.querySelector('.i-pipe')?.value ?? '',
        generatedDate: rowEl.querySelector('.i-gen')?.value ?? '',
        davidProjectNotes: rowEl.querySelector('.i-david')?.value ?? '',
        executiveBrief: rowEl.querySelector('.i-brief')?.value ?? '',
        errorLog: rowEl.querySelector('.i-err')?.value ?? '',
      };
      await api(`/intelligence/${rowIndex}`, { method: 'PATCH', body: JSON.stringify(body) });
      await reloadOperatorTables();
      activateTab('intel');
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  document.getElementById('profiles-mount')?.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.getAttribute('data-act') !== 'save-p') return;
    const rowEl = t.closest('.p-row');
    if (!(rowEl instanceof HTMLElement)) return;
    const rowIndex = parseInt(rowEl.getAttribute('data-row') || '', 10);
    void handleProfileSave(rowIndex, rowEl);
  });

  async function handleProfileSave(rowIndex, rowEl) {
    clearError();
    setLoading(true);
    try {
      const body = {
        companyUrl: rowEl.querySelector('.p-url')?.value ?? '',
        companyName: rowEl.querySelector('.p-name')?.value ?? '',
        industry: rowEl.querySelector('.p-ind')?.value ?? '',
        productSummary: rowEl.querySelector('.p-prod')?.value ?? '',
        companySize: rowEl.querySelector('.p-size')?.value ?? '',
        signals: rowEl.querySelector('.p-sig')?.value ?? '',
        signalSummary: rowEl.querySelector('.p-sigs')?.value ?? '',
        deatonCapabilitiesMatched: rowEl.querySelector('.p-cap')?.value ?? '',
        caseStudiesSelected: rowEl.querySelector('.p-cases')?.value ?? '',
        alignmentRationale: rowEl.querySelector('.p-align')?.value ?? '',
        confidenceScore: rowEl.querySelector('.p-conf')?.value ?? '',
        pipelineStatus: rowEl.querySelector('.p-pipe')?.value ?? '',
        researchedDate: rowEl.querySelector('.p-res')?.value ?? '',
        lastRefreshedAt: rowEl.querySelector('.p-lref')?.value ?? '',
        profileVersion: rowEl.querySelector('.p-ver')?.value ?? '',
        errorLog: rowEl.querySelector('.p-err')?.value ?? '',
      };
      await api(`/company-profiles/${rowIndex}`, { method: 'PATCH', body: JSON.stringify(body) });
      await reloadOperatorTables();
      void loadOverview();
      activateTab('profiles');
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  document.getElementById('pl-run')?.addEventListener('click', async () => {
    clearError();
    const email = document.getElementById('pl-email')?.value?.trim() || '';
    const reset = document.getElementById('pl-reset')?.value || 'auto';
    const out = document.getElementById('pl-out');
    if (!email) {
      showError('Enter an email.');
      return;
    }
    setLoading(true);
    try {
      const res = await api('/pipeline/run-contact', { method: 'POST', body: JSON.stringify({ email, reset }) });
      if (out) {
        out.hidden = false;
        out.textContent = JSON.stringify(res, null, 2);
      }
      void loadOverview();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  });

  document.getElementById('pl-cycle')?.addEventListener('click', async () => {
    clearError();
    const out = document.getElementById('pl-cycle-out');
    if (!window.confirm('Run full pipeline cycle for ALL eligible contacts?')) return;
    setLoading(true);
    try {
      const res = await api('/pipeline/run-cycle', { method: 'POST', body: '{}' });
      if (out) {
        out.hidden = false;
        out.textContent = JSON.stringify(res, null, 2);
      }
      void loadOverview();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  });

  const tokInput = document.getElementById('dashboard-token');
  if (tokInput && 'value' in tokInput) tokInput.value = getToken();
  if (getToken()) setTokenStatus('Token loaded from session.');

  void loadOverview();
})();
