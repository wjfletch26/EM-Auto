/**
 * Minimal dashboard client — no bundler; runs in the browser on the unsubscribe port.
 * Fetches JSON from /api/dashboard/summary and renders cards + sortable breakdown tables.
 */

(function () {
  const summaryUrl = '/api/dashboard/summary';

  /** @param {Record<string, number>} counts */
  function sortedEntries(counts) {
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  /** @param {Record<string, number>} counts */
  function renderBars(counts) {
    const entries = sortedEntries(counts);
    if (entries.length === 0) {
      return '<p class="muted">No rows.</p>';
    }
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
    el.textContent = isLoading ? 'Loading…' : '';
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

  async function load() {
    setLoading(true);
    clearError();
    try {
      const res = await fetch(summaryUrl);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data.detail ? ` (${data.detail})` : '';
        throw new Error((data.error || res.statusText) + detail);
      }
      render(data);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function render(data) {
    const gen = document.getElementById('generated-at');
    if (gen) {
      gen.textContent = new Date(data.generatedAt).toLocaleString();
    }

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
            (row) => `<tr><td>${escapeHtml(row.contactEmail)}</td><td class="mono">${escapeHtml(row.preview)}</td></tr>`,
          )
          .join('');
      }
    }

    const rq = data.reviewQueue;
    document.getElementById('metric-queue-total').textContent = String(rq.total);
    document.getElementById('breakdown-queue').innerHTML = renderBars(rq.status);
  }

  document.getElementById('refresh')?.addEventListener('click', () => {
    void load();
  });

  void load();
})();
