import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminFetch, getStoredApiKey, setStoredApiKey } from './api';

type Tab = 'contacts' | 'intel' | 'review' | 'actions';

/** Contact row shape from GET /contacts (mirrors backend). */
type ContactRow = Record<string, unknown> & { email: string; _rowIndex: number };

/** Company intelligence row from API. */
type IntelRow = Record<string, unknown> & { contactEmail: string; _rowIndex: number };

/** Review queue row from API (subject/body from generated sequence). */
type ReviewRow = Record<string, unknown> & {
  contactEmail: string;
  companyName: string;
  _rowIndex: number;
  stepNumber: number;
  emailPurpose: string;
  subject: string;
  body: string;
  status: string;
  reviewerNotes: string;
  generatedDate: string;
  campaignId: string;
};

export function App(): JSX.Element {
  const [apiKeyInput, setApiKeyInput] = useState(getStoredApiKey);
  const [tab, setTab] = useState<Tab>('contacts');
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [intelRows, setIntelRows] = useState<IntelRow[]>([]);
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [reviewFilterEmail, setReviewFilterEmail] = useState('');
  /** Row selected to show full email content below the table. */
  const [selectedReviewRow, setSelectedReviewRow] = useState<ReviewRow | null>(null);

  const [selectedContact, setSelectedContact] = useState<ContactRow | null>(null);
  const [contactDraft, setContactDraft] = useState<Record<string, string>>({});

  const [selectedIntel, setSelectedIntel] = useState<IntelRow | null>(null);
  const [intelDraft, setIntelDraft] = useState<Record<string, string>>({});

  const [newContact, setNewContact] = useState({
    email: '',
    firstName: '',
    lastName: '',
    company: '',
    title: '',
    campaignId: '',
    companyUrl: '',
  });

  const [importJson, setImportJson] = useState('[\n  { "email": "a@b.com", "firstName": "Ann" }\n]');
  const [actionEmail, setActionEmail] = useState('');

  const showMsg = useCallback((type: 'ok' | 'err', text: string) => {
    setMessage({ type, text });
  }, []);

  const refreshContacts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch<{ contacts: ContactRow[] }>('/contacts');
      setContacts(data.contacts);
      showMsg('ok', `Loaded ${data.contacts.length} contacts`);
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [showMsg]);

  const refreshIntel = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch<{ companyIntelligence: IntelRow[] }>('/company-intelligence');
      setIntelRows(data.companyIntelligence);
      showMsg('ok', `Loaded ${data.companyIntelligence.length} intel rows`);
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [showMsg]);

  const refreshReview = useCallback(async () => {
    setLoading(true);
    try {
      const q = reviewFilterEmail.trim()
        ? `?email=${encodeURIComponent(reviewFilterEmail.trim().toLowerCase())}`
        : '';
      const data = await adminFetch<{ reviewQueue: ReviewRow[] }>(`/review-queue${q}`);
      setReviewRows(data.reviewQueue);
      // Keep email preview aligned with sheet after refresh (e.g. after Approve).
      setSelectedReviewRow((prev) => {
        if (!prev) return null;
        return data.reviewQueue.find((x) => x._rowIndex === prev._rowIndex) ?? null;
      });
      showMsg('ok', `Loaded ${data.reviewQueue.length} review rows`);
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [reviewFilterEmail, showMsg]);

  useEffect(() => {
    if (!getStoredApiKey().trim()) return;
    if (tab === 'contacts') void refreshContacts();
    if (tab === 'intel') void refreshIntel();
    if (tab === 'review') void refreshReview();
  }, [tab, refreshContacts, refreshIntel, refreshReview]);

  useEffect(() => {
    if (!selectedContact) {
      setContactDraft({});
      return;
    }
    const c = selectedContact;
    const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    setContactDraft({
      firstName: str(c.firstName),
      lastName: str(c.lastName),
      company: str(c.company),
      title: str(c.title),
      campaignId: str(c.campaignId),
      status: str(c.status),
      lastStepSent: str(c.lastStepSent),
      companyUrl: str(c.companyUrl),
      pipelineStatus: str(c.pipelineStatus),
      custom1: str(c.custom1),
      custom2: str(c.custom2),
      notes: str(c.notes),
    });
  }, [selectedContact]);

  useEffect(() => {
    if (!selectedIntel) {
      setIntelDraft({});
      return;
    }
    const r = selectedIntel;
    const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    setIntelDraft({
      companyName: str(r.companyName),
      industry: str(r.industry),
      productSummary: str(r.productSummary),
      companySize: str(r.companySize),
      signals: str(r.signals),
      signalSummary: str(r.signalSummary),
      deatonCapabilitiesMatched: str(r.deatonCapabilitiesMatched),
      caseStudiesSelected: str(r.caseStudiesSelected),
      alignmentRationale: str(r.alignmentRationale),
      confidenceScore: str(r.confidenceScore),
      davidProjectNotes: str(r.davidProjectNotes),
      executiveBrief: str(r.executiveBrief),
      pipelineStatus: str(r.pipelineStatus),
      researchedDate: str(r.researchedDate),
      generatedDate: str(r.generatedDate),
      errorLog: str(r.errorLog),
    });
  }, [selectedIntel]);

  const saveApiKey = () => {
    setStoredApiKey(apiKeyInput.trim());
    showMsg('ok', 'API key saved in this browser');
  };

  const saveContactPatch = async () => {
    if (!selectedContact) return;
    setLoading(true);
    try {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(contactDraft)) {
        if (k === 'lastStepSent') body[k] = parseInt(v, 10) || 0;
        else body[k] = v;
      }
      await adminFetch(`/contacts/${encodeURIComponent(selectedContact.email)}`, {
        method: 'PATCH',
        json: body,
      });
      showMsg('ok', 'Contact updated');
      await refreshContacts();
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const archiveContact = async () => {
    if (!selectedContact) return;
    if (!window.confirm(`Archive (soft-delete) ${selectedContact.email}?`)) return;
    setLoading(true);
    try {
      await adminFetch(`/contacts/${encodeURIComponent(selectedContact.email)}/archive`, {
        method: 'POST',
      });
      showMsg('ok', 'Contact archived');
      setSelectedContact(null);
      await refreshContacts();
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const createContact = async () => {
    setLoading(true);
    try {
      await adminFetch('/contacts', {
        method: 'POST',
        json: newContact,
      });
      showMsg('ok', 'Contact created');
      setNewContact({
        email: '',
        firstName: '',
        lastName: '',
        company: '',
        title: '',
        campaignId: '',
        companyUrl: '',
      });
      await refreshContacts();
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const runImport = async () => {
    let rows: unknown[];
    try {
      rows = JSON.parse(importJson) as unknown[];
      if (!Array.isArray(rows)) throw new Error('JSON must be an array');
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : 'Invalid JSON');
      return;
    }
    setLoading(true);
    try {
      const data = await adminFetch<{ imported: number; failed: number; errors: string[] }>(
        '/contacts/import',
        { method: 'POST', json: { rows } },
      );
      showMsg(
        data.failed ? 'err' : 'ok',
        `Imported ${data.imported}, failed ${data.failed}. ${data.errors.slice(0, 5).join('; ')}`,
      );
      await refreshContacts();
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const saveIntelPatch = async () => {
    if (!selectedIntel) return;
    setLoading(true);
    try {
      await adminFetch(`/company-intelligence/${encodeURIComponent(selectedIntel.contactEmail)}`, {
        method: 'PATCH',
        json: intelDraft,
      });
      showMsg('ok', 'Company intelligence updated');
      await refreshIntel();
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const saveReviewRow = async (row: ReviewRow, patch: Partial<ReviewRow>) => {
    setLoading(true);
    try {
      await adminFetch(`/review-queue/${row._rowIndex}`, {
        method: 'PATCH',
        json: patch,
      });
      showMsg('ok', 'Review queue row updated');
      await refreshReview();
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const postAction = async (path: string) => {
    setLoading(true);
    try {
      const data = await adminFetch(path, { method: 'POST' });
      showMsg('ok', JSON.stringify(data));
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const researchAgain = async () => {
    const email = actionEmail.trim().toLowerCase();
    if (!email) {
      showMsg('err', 'Enter contact email');
      return;
    }
    await postAction(`/actions/contacts/${encodeURIComponent(email)}/research-again`);
  };

  const regenerateSequence = async () => {
    const email = actionEmail.trim().toLowerCase();
    if (!email) {
      showMsg('err', 'Enter contact email');
      return;
    }
    await postAction(`/actions/contacts/${encodeURIComponent(email)}/regenerate-sequence`);
  };

  const tabButtons = useMemo(
    () =>
      (
        [
          ['contacts', 'Contacts'],
          ['intel', 'Company intelligence'],
          ['review', 'Review queue'],
          ['actions', 'Sequence actions'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={tab === id ? 'active' : ''}
          onClick={() => setTab(id)}
        >
          {label}
        </button>
      )),
    [tab],
  );

  return (
    <div className="app">
      <h1>Deaton Outreach — Admin</h1>

      <div className="toolbar">
        <label>
          ADMIN_API_KEY (stored locally)
          <input
            type="password"
            autoComplete="off"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="Paste key from .env"
          />
        </label>
        <button type="button" className="primary" onClick={saveApiKey}>
          Save key
        </button>
      </div>

      {message ? (
        <div className={`msg ${message.type === 'err' ? 'err' : 'ok'}`}>{message.text}</div>
      ) : null}

      <div className="tabs">{tabButtons}</div>

      {tab === 'contacts' ? (
        <>
          <div className="panel">
            <h2>Contact list</h2>
            <div className="row-actions">
              <button type="button" className="secondary" disabled={loading} onClick={() => void refreshContacts()}>
                Refresh
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Company</th>
                    <th>Status</th>
                    <th>Pipeline</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr
                      key={c.email}
                      className={selectedContact?.email === c.email ? 'selected' : ''}
                      onClick={() => setSelectedContact(c)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>{c.email}</td>
                      <td>
                        {String(c.firstName)} {String(c.lastName)}
                      </td>
                      <td>{String(c.company)}</td>
                      <td>{String(c.status)}</td>
                      <td>{String(c.pipelineStatus)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {selectedContact ? (
            <div className="panel">
              <h2>Edit contact — {selectedContact.email}</h2>
              <p style={{ fontSize: '0.85rem', color: '#9aa0a6' }}>
                Email is read-only here (primary key). Update other fields and save.
              </p>
              <div className="form-grid">
                {(
                  [
                    ['firstName', 'First name'],
                    ['lastName', 'Last name'],
                    ['company', 'Company'],
                    ['title', 'Title'],
                    ['campaignId', 'Campaign ID'],
                    ['status', 'Status'],
                    ['lastStepSent', 'Last step sent'],
                    ['companyUrl', 'Company URL'],
                    ['pipelineStatus', 'Pipeline status'],
                    ['custom1', 'Custom 1'],
                    ['custom2', 'Custom 2'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      value={contactDraft[key] ?? ''}
                      onChange={(e) => setContactDraft((d) => ({ ...d, [key]: e.target.value }))}
                    />
                  </label>
                ))}
                <label style={{ gridColumn: '1 / -1' }}>
                  Notes
                  <textarea
                    value={contactDraft.notes ?? ''}
                    onChange={(e) => setContactDraft((d) => ({ ...d, notes: e.target.value }))}
                  />
                </label>
              </div>
              <div className="row-actions">
                <button type="button" className="primary" disabled={loading} onClick={() => void saveContactPatch()}>
                  Save changes
                </button>
                <button type="button" className="secondary danger" disabled={loading} onClick={() => void archiveContact()}>
                  Archive (soft delete)
                </button>
              </div>
            </div>
          ) : null}

          <div className="panel">
            <h2>New contact</h2>
            <div className="form-grid">
              <label>
                Email *
                <input
                  value={newContact.email}
                  onChange={(e) => setNewContact((n) => ({ ...n, email: e.target.value }))}
                />
              </label>
              <label>
                First name *
                <input
                  value={newContact.firstName}
                  onChange={(e) => setNewContact((n) => ({ ...n, firstName: e.target.value }))}
                />
              </label>
              <label>
                Last name
                <input
                  value={newContact.lastName}
                  onChange={(e) => setNewContact((n) => ({ ...n, lastName: e.target.value }))}
                />
              </label>
              <label>
                Company
                <input
                  value={newContact.company}
                  onChange={(e) => setNewContact((n) => ({ ...n, company: e.target.value }))}
                />
              </label>
              <label>
                Title
                <input
                  value={newContact.title}
                  onChange={(e) => setNewContact((n) => ({ ...n, title: e.target.value }))}
                />
              </label>
              <label>
                Campaign ID
                <input
                  value={newContact.campaignId}
                  onChange={(e) => setNewContact((n) => ({ ...n, campaignId: e.target.value }))}
                />
              </label>
              <label>
                Company URL
                <input
                  value={newContact.companyUrl}
                  onChange={(e) => setNewContact((n) => ({ ...n, companyUrl: e.target.value }))}
                />
              </label>
            </div>
            <div className="row-actions">
              <button type="button" className="primary" disabled={loading} onClick={() => void createContact()}>
                Create contact
              </button>
            </div>
          </div>

          <div className="panel">
            <h2>Import JSON</h2>
            <p style={{ fontSize: '0.85rem', color: '#9aa0a6' }}>
              POST body shape: <code>{'{"rows": [ { "email", "firstName", ... } ] }'}</code> — array of contact objects
              (same fields as create).
            </p>
            <textarea
              style={{ width: '100%', minHeight: 140, fontFamily: 'monospace', fontSize: '0.8rem' }}
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
            />
            <div className="row-actions">
              <button type="button" className="primary" disabled={loading} onClick={() => void runImport()}>
                Import rows
              </button>
            </div>
          </div>
        </>
      ) : null}

      {tab === 'intel' ? (
        <>
          <div className="panel">
            <h2>Company intelligence</h2>
            <div className="row-actions">
              <button type="button" className="secondary" disabled={loading} onClick={() => void refreshIntel()}>
                Refresh
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Company</th>
                    <th>Industry</th>
                    <th>Pipeline</th>
                  </tr>
                </thead>
                <tbody>
                  {intelRows.map((r) => (
                    <tr
                      key={`${r.contactEmail}-${r._rowIndex}`}
                      className={selectedIntel?.contactEmail === r.contactEmail ? 'selected' : ''}
                      onClick={() => setSelectedIntel(r)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>{r.contactEmail}</td>
                      <td>{String(r.companyName)}</td>
                      <td>{String(r.industry)}</td>
                      <td>{String(r.pipelineStatus)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {selectedIntel ? (
            <div className="panel">
              <h2>Edit intel — {selectedIntel.contactEmail}</h2>
              <div className="form-grid">
                {(
                  [
                    ['companyName', 'Company name'],
                    ['industry', 'Industry'],
                    ['productSummary', 'Product summary'],
                    ['companySize', 'Company size'],
                    ['signals', 'Signals (JSON)'],
                    ['signalSummary', 'Signal summary'],
                    ['deatonCapabilitiesMatched', 'Capabilities matched'],
                    ['caseStudiesSelected', 'Case studies'],
                    ['alignmentRationale', 'Alignment rationale'],
                    ['confidenceScore', 'Confidence'],
                    ['davidProjectNotes', 'David / project notes'],
                    ['pipelineStatus', 'Pipeline status'],
                    ['researchedDate', 'Researched date'],
                    ['generatedDate', 'Generated date'],
                    ['errorLog', 'Error log'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    {key === 'signals' || key === 'alignmentRationale' || key === 'errorLog' ? (
                      <textarea
                        value={intelDraft[key] ?? ''}
                        onChange={(e) => setIntelDraft((d) => ({ ...d, [key]: e.target.value }))}
                      />
                    ) : (
                      <input
                        value={intelDraft[key] ?? ''}
                        onChange={(e) => setIntelDraft((d) => ({ ...d, [key]: e.target.value }))}
                      />
                    )}
                  </label>
                ))}
                <label style={{ gridColumn: '1 / -1' }}>
                  Executive brief
                  <textarea
                    value={intelDraft.executiveBrief ?? ''}
                    onChange={(e) => setIntelDraft((d) => ({ ...d, executiveBrief: e.target.value }))}
                  />
                </label>
              </div>
              <div className="row-actions">
                <button type="button" className="primary" disabled={loading} onClick={() => void saveIntelPatch()}>
                  Save intel
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === 'review' ? (
        <div className="panel">
          <h2>Review queue</h2>
          <p style={{ fontSize: '0.85rem', color: '#9aa0a6', marginTop: 0 }}>
            Click <strong>View</strong> on a row to read the generated subject and body. Use the status buttons after
            reviewing.
          </p>
          <div className="row-actions" style={{ alignItems: 'center' }}>
            <label>
              Filter by email
              <input
                type="text"
                value={reviewFilterEmail}
                onChange={(e) => setReviewFilterEmail(e.target.value)}
                placeholder="leave empty for all"
              />
            </label>
            <button type="button" className="secondary" disabled={loading} onClick={() => void refreshReview()}>
              Refresh
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Contact</th>
                  <th>Step</th>
                  <th>Subject (preview)</th>
                  <th>Status</th>
                  <th>Campaign</th>
                  <th>View / actions</th>
                </tr>
              </thead>
              <tbody>
                {reviewRows.map((r) => {
                  const subj = String(r.subject ?? '');
                  const preview = subj.length > 56 ? `${subj.slice(0, 56)}…` : subj;
                  const isSel = selectedReviewRow?._rowIndex === r._rowIndex;
                  return (
                    <tr key={r._rowIndex} className={isSel ? 'selected' : ''}>
                      <td>{r._rowIndex}</td>
                      <td>{r.contactEmail}</td>
                      <td>{r.stepNumber}</td>
                      <td title={subj}>{preview || '—'}</td>
                      <td>{r.status}</td>
                      <td>{String(r.campaignId)}</td>
                      <td>
                        <button
                          type="button"
                          className="primary"
                          onClick={() => setSelectedReviewRow(r)}
                        >
                          View
                        </button>{' '}
                        <button
                          type="button"
                          className="secondary"
                          disabled={loading}
                          onClick={(e) => {
                            e.stopPropagation();
                            void saveReviewRow(r, { status: 'approved' });
                          }}
                        >
                          Approve
                        </button>{' '}
                        <button
                          type="button"
                          className="secondary"
                          disabled={loading}
                          onClick={(e) => {
                            e.stopPropagation();
                            void saveReviewRow(r, { status: 'pending_review' });
                          }}
                        >
                          Pending
                        </button>{' '}
                        <button
                          type="button"
                          className="secondary"
                          disabled={loading}
                          onClick={(e) => {
                            e.stopPropagation();
                            void saveReviewRow(r, { status: 'superseded' });
                          }}
                        >
                          Supersede
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selectedReviewRow ? (
            <div className="review-email-panel">
              <div className="review-email-panel-header">
                <h3>
                  Step {selectedReviewRow.stepNumber} — sheet row {selectedReviewRow._rowIndex}
                </h3>
                <button type="button" className="secondary" onClick={() => setSelectedReviewRow(null)}>
                  Close preview
                </button>
              </div>
              <p className="review-meta">
                <strong>To:</strong> {selectedReviewRow.contactEmail}
                {String(selectedReviewRow.companyName) ? (
                  <>
                    {' '}
                    · <strong>Company:</strong> {String(selectedReviewRow.companyName)}
                  </>
                ) : null}
                {String(selectedReviewRow.generatedDate) ? (
                  <>
                    {' '}
                    · <strong>Generated:</strong> {String(selectedReviewRow.generatedDate)}
                  </>
                ) : null}
              </p>
              <div className="review-field">
                <span className="review-label">Purpose</span>
                <div className="review-value">{String(selectedReviewRow.emailPurpose ?? '—')}</div>
              </div>
              <div className="review-field">
                <span className="review-label">Subject</span>
                <div className="review-value review-subject">{String(selectedReviewRow.subject ?? '')}</div>
              </div>
              <div className="review-field">
                <span className="review-label">Body</span>
                <div className="review-body">{String(selectedReviewRow.body ?? '')}</div>
              </div>
              {String(selectedReviewRow.reviewerNotes ?? '').trim() ? (
                <div className="review-field">
                  <span className="review-label">Reviewer / QC notes</span>
                  <div className="review-value review-qc">{String(selectedReviewRow.reviewerNotes)}</div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'actions' ? (
        <div className="panel">
          <h2>Sequence and pipeline</h2>
          <p style={{ fontSize: '0.85rem', color: '#9aa0a6' }}>
            Requires <code>PIPELINE_ENABLED=true</code> for pipeline actions. Send cycle uses the same mutex as cron
            (409 if busy).
          </p>
          <div className="row-actions">
            <button type="button" className="primary" disabled={loading} onClick={() => void postAction('/actions/send-cycle')}>
              Run send cycle now
            </button>
            <button type="button" className="secondary" disabled={loading} onClick={() => void postAction('/actions/pipeline-cycle')}>
              Run pipeline cycle
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => void postAction('/actions/approval-watcher')}
            >
              Run approval watcher
            </button>
          </div>
          <label style={{ display: 'block', marginTop: '1rem' }}>
            Contact email (research / regenerate)
            <input
              type="text"
              style={{ width: '100%', maxWidth: 400 }}
              value={actionEmail}
              onChange={(e) => setActionEmail(e.target.value)}
              placeholder="name@company.com"
            />
          </label>
          <div className="row-actions" style={{ marginTop: '0.75rem' }}>
            <button type="button" className="secondary" disabled={loading} onClick={() => void researchAgain()}>
              Research again
            </button>
            <button type="button" className="secondary" disabled={loading} onClick={() => void regenerateSequence()}>
              Regenerate sequence
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
