import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminFetch, getStoredApiKey, setStoredApiKey } from './api';
import { formatSequenceActionSuccess } from './sequence-action-feedback';

type Tab = 'contacts' | 'intel' | 'profiles' | 'review' | 'actions';

/** Company intelligence row from API (per-contact briefing + linkage). */
type IntelRow = Record<string, unknown> & {
  contactEmail: string;
  canonicalCompanyUrl: string;
  _rowIndex: number;
};

/** One shared company profile row — research + alignment. */
type ProfileRow = Record<string, unknown> & { canonicalCompanyUrl: string; _rowIndex: number };

/** Subset of GET /health for operator banners (no auth). */
type HealthPreview = {
  status: string;
  appEnv: string;
  safeMode: boolean;
  dryRun: boolean;
  emailMode: string;
  deploy?: { sha?: string; branch?: string };
};

function EnvBannerBar({
  health,
  healthError,
}: {
  health: HealthPreview | null;
  healthError: string | null;
}): JSX.Element {
  if (healthError) {
    return (
      <div className="env-banner-bar" role="status">
        <span className="env-chip env-chip-warn">HEALTH: {healthError}</span>
      </div>
    );
  }
  if (!health) {
    return (
      <div className="env-banner-bar" role="status">
        <span className="env-chip env-chip-muted">
          Environment: open /health (start backend) to show PRODUCTION / SAFE MODE / DRY RUN flags
        </span>
      </div>
    );
  }

  const chips: JSX.Element[] = [];
  if (health.appEnv === 'production') {
    chips.push(
      <span key="prod" className="env-chip env-chip-production">
        PRODUCTION
      </span>,
    );
  } else if (health.appEnv === 'staging') {
    chips.push(
      <span key="stg" className="env-chip env-chip-staging">
        STAGING
      </span>,
    );
  } else {
    chips.push(
      <span key="loc" className="env-chip env-chip-local">
        LOCAL
      </span>,
    );
  }

  if (health.safeMode) {
    chips.push(
      <span key="safe" className="env-chip env-chip-safe">
        SAFE MODE
      </span>,
    );
  }
  if (health.dryRun || health.emailMode === 'simulated_send') {
    chips.push(
      <span key="dry" className="env-chip env-chip-dry">
        DRY RUN
      </span>,
    );
  }
  if (health.emailMode === 'test_recipient' && health.appEnv !== 'production') {
    chips.push(
      <span key="tr" className="env-chip env-chip-testrecv">
        TEST RECIPIENT
      </span>,
    );
  }
  if (health.emailMode === 'production_live') {
    chips.push(
      <span key="live" className="env-chip env-chip-live">
        LIVE MAIL
      </span>,
    );
  }

  const sha = health.deploy?.sha?.slice(0, 7);
  if (sha) {
    chips.push(
      <span key="sha" className="env-chip env-chip-muted">
        SHA {sha}
      </span>,
    );
  }

  chips.push(
    <span key="st" className="env-chip env-chip-muted">
      {health.status}
    </span>,
  );

  return <div className="env-banner-bar">{chips}</div>;
}

/** Contact row shape from GET /contacts (mirrors backend). */
type ContactRow = Record<string, unknown> & { email: string; _rowIndex: number };

/** Server contract for POST /contacts/import preview + commit. */
type ImportErrorItem = { row: number; code: string; message: string };

type ContactImportResponse = {
  totalRows: number;
  /** Dry-run only: rows that passed validation + duplicate checks (would append). */
  wouldImport?: number;
  /** Commit only */
  imported?: number;
  duplicateInFile: number;
  duplicateInSheet: number;
  invalidRows: number;
  appendFailed?: number;
  preview?: Array<{ row: number; mapped: Record<string, unknown> }>;
  errors: ImportErrorItem[];
};

/** Mirror server MVP_IMPORT limits for early client rejection (server still enforces). */
const IMPORT_MAX_UTF8_BYTES = 5 * 1024 * 1024;

const IMPORT_MAX_DATA_ROWS = 10_000;

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Rough non-empty-line count minus header row — UX hint only; server uses Papa `skipEmptyLines`.
 */
function estimatedDataRowsFromCsvText(raw: string): number {
  const lines = raw.trim().split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  return Math.max(0, lines.length - 1);
}

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
  const [profileRows, setProfileRows] = useState<ProfileRow[]>([]);
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [reviewFilterEmail, setReviewFilterEmail] = useState('');
  /** Row selected to show full email content below the table. */
  const [selectedReviewRow, setSelectedReviewRow] = useState<ReviewRow | null>(null);

  const [selectedContact, setSelectedContact] = useState<ContactRow | null>(null);
  const [contactDraft, setContactDraft] = useState<Record<string, string>>({});

  const [selectedIntel, setSelectedIntel] = useState<IntelRow | null>(null);
  const [intelDraft, setIntelDraft] = useState<Record<string, string>>({});

  const [selectedProfile, setSelectedProfile] = useState<ProfileRow | null>(null);
  const [profileDraft, setProfileDraft] = useState<Record<string, string>>({});

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
  /** Pasted or file-loaded CSV/TSV for the primary import path. */
  const [importSpreadsheetText, setImportSpreadsheetText] = useState('');
  /** Server-side Papa delimiter: auto picks tab when the header line contains a tab. */
  const [importDelimiter, setImportDelimiter] = useState<'auto' | 'tab' | 'comma'>('auto');
  /** Last dry-run response for spreadsheet or JSON preview. */
  const [importPreview, setImportPreview] = useState<ContactImportResponse | null>(null);
  /** Client-side filter on Sequence actions tab (matches email, name, or company). */
  const [sequenceFilterEmail, setSequenceFilterEmail] = useState('');

  const [healthPreview, setHealthPreview] = useState<HealthPreview | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/health')
      .then(async (r) => {
        const text = await r.text();
        if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 160)}`);
        return JSON.parse(text) as HealthPreview;
      })
      .then((h) => {
        if (!cancelled) {
          setHealthPreview(h);
          setHealthError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setHealthPreview(null);
          setHealthError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const refreshProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch<{ companyProfiles: ProfileRow[] }>('/company-profiles');
      setProfileRows(data.companyProfiles);
      showMsg('ok', `Loaded ${data.companyProfiles.length} company profiles`);
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
    if (tab === 'contacts' || tab === 'actions') void refreshContacts();
    if (tab === 'intel') void refreshIntel();
    if (tab === 'profiles') void refreshProfiles();
    if (tab === 'review') void refreshReview();
  }, [tab, refreshContacts, refreshIntel, refreshProfiles, refreshReview]);

  const sequenceContactsFiltered = useMemo(() => {
    const q = sequenceFilterEmail.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const email = c.email.toLowerCase();
      const first = String(c.firstName ?? '').toLowerCase();
      const last = String(c.lastName ?? '').toLowerCase();
      const company = String(c.company ?? '').toLowerCase();
      return (
        email.includes(q) ||
        first.includes(q) ||
        last.includes(q) ||
        company.includes(q) ||
        `${first} ${last}`.trim().includes(q)
      );
    });
  }, [contacts, sequenceFilterEmail]);

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
      canonicalCompanyUrl: str(r.canonicalCompanyUrl),
      companyUrl: str(r.companyUrl),
      davidProjectNotes: str(r.davidProjectNotes),
      executiveBrief: str(r.executiveBrief),
      pipelineStatus: str(r.pipelineStatus),
      generatedDate: str(r.generatedDate),
      errorLog: str(r.errorLog),
    });
  }, [selectedIntel]);

  useEffect(() => {
    if (!selectedProfile) {
      setProfileDraft({});
      return;
    }
    const r = selectedProfile;
    const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    setProfileDraft({
      companyUrl: str(r.companyUrl),
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
      pipelineStatus: str(r.pipelineStatus),
      researchedDate: str(r.researchedDate),
      lastRefreshedAt: str(r.lastRefreshedAt),
      profileVersion: str(r.profileVersion),
      errorLog: str(r.errorLog),
    });
  }, [selectedProfile]);

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

  /** Client-side row-count guard aligned with CONTACT_IMPORT_ROW_CAP on the server. */
  function assertImportJsonWithinClientLimits(rows: unknown[]): void {
    if (rows.length > IMPORT_MAX_DATA_ROWS) {
      throw new Error(`At most ${IMPORT_MAX_DATA_ROWS} rows (${rows.length} provided).`);
    }
  }

  const loadSpreadsheetFile = (file: File) => {
    if (file.size > IMPORT_MAX_UTF8_BYTES) {
      showMsg('err', `File is ${file.size} bytes; max payload is ${IMPORT_MAX_UTF8_BYTES} (5 MiB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setImportSpreadsheetText(text);
      setImportPreview(null);
      showMsg('ok', `Loaded ${file.name} (${file.size} bytes)`);
    };
    reader.onerror = () => showMsg('err', 'Could not read file');
    reader.readAsText(file, 'UTF-8');
  };

  const runSpreadsheetImport = async (dryRun: boolean) => {
    const text = importSpreadsheetText;
    if (!text.trim()) {
      showMsg('err', 'Paste or load CSV / TSV first.');
      return;
    }
    const bytes = utf8ByteLength(text);
    if (bytes > IMPORT_MAX_UTF8_BYTES) {
      showMsg('err', `Import text is about ${bytes} UTF-8 bytes; max allowed is ${IMPORT_MAX_UTF8_BYTES} (5 MiB).`);
      return;
    }
    const est = estimatedDataRowsFromCsvText(text);
    if (est > IMPORT_MAX_DATA_ROWS) {
      showMsg(
        'err',
        `Roughly ${est} data rows (by line count); max is ${IMPORT_MAX_DATA_ROWS}. Remove rows or split the file.`,
      );
      return;
    }

    setLoading(true);
    try {
      const data = await adminFetch<ContactImportResponse>('/contacts/import', {
        method: 'POST',
        json: { spreadsheetText: text, delimiter: importDelimiter, dryRun },
      });
      const summaryPieces = dryRun
        ? [
            `Preview: ${data.totalRows} rows`,
            `would import ${data.wouldImport ?? 0}`,
            `invalid ${data.invalidRows}`,
            `dup(file) ${data.duplicateInFile}`,
            `dup(sheet) ${data.duplicateInSheet}`,
          ]
        : [
            `Imported ${data.imported ?? 0}`,
            `${data.totalRows} rows`,
            `invalid ${data.invalidRows}`,
            `dup(file) ${data.duplicateInFile}`,
            `dup(sheet) ${data.duplicateInSheet}`,
            ...(data.appendFailed ? [`append_failed ${data.appendFailed}`] : []),
          ];
      showMsg(
        data.invalidRows || data.duplicateInFile || data.duplicateInSheet ? 'err' : 'ok',
        summaryPieces.join('; '),
      );
      if (dryRun) setImportPreview(data);
      else {
        setImportPreview(null);
        await refreshContacts();
      }
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const runJsonImport = async (dryRun: boolean) => {
    let rows: unknown[];
    try {
      rows = JSON.parse(importJson) as unknown[];
      if (!Array.isArray(rows)) throw new Error('JSON must be an array');
      assertImportJsonWithinClientLimits(rows);
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : 'Invalid JSON');
      return;
    }
    const bodyBytes = utf8ByteLength(importJson);
    if (bodyBytes > IMPORT_MAX_UTF8_BYTES) {
      showMsg('err', `JSON is ${bodyBytes} UTF-8 bytes; max is ${IMPORT_MAX_UTF8_BYTES} (5 MiB).`);
      return;
    }

    setLoading(true);
    try {
      const data = await adminFetch<ContactImportResponse>('/contacts/import', {
        method: 'POST',
        json: { rows, dryRun },
      });
      const summaryPieces = dryRun
        ? [
            `Preview: ${data.totalRows} rows`,
            `would import ${data.wouldImport ?? 0}`,
            `invalid ${data.invalidRows}`,
            `dup(file) ${data.duplicateInFile}`,
            `dup(sheet) ${data.duplicateInSheet}`,
          ]
        : [
            `Imported ${data.imported ?? 0}`,
            `${data.totalRows} rows`,
            `invalid ${data.invalidRows}`,
            ...(data.appendFailed ? [`append_failed ${data.appendFailed}`] : []),
          ];
      showMsg(
        data.invalidRows || data.duplicateInFile || data.duplicateInSheet ? 'err' : 'ok',
        summaryPieces.join('; '),
      );
      if (dryRun) setImportPreview(data);
      else {
        setImportPreview(null);
        await refreshContacts();
      }
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

  const saveProfilePatch = async () => {
    if (!selectedProfile) return;
    setLoading(true);
    try {
      await adminFetch(`/company-profiles/${selectedProfile._rowIndex}`, {
        method: 'PATCH',
        json: profileDraft,
      });
      showMsg('ok', 'Company profile updated');
      await refreshProfiles();
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
      const data = await adminFetch<Record<string, unknown>>(path, { method: 'POST' });
      showMsg('ok', formatSequenceActionSuccess(path, data));
    } catch (e) {
      showMsg('err', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const researchAgainForEmail = async (email: string) => {
    await postAction(`/actions/contacts/${encodeURIComponent(email.trim().toLowerCase())}/research-again`);
    await refreshContacts();
  };

  const regenerateSequenceForEmail = async (email: string) => {
    await postAction(`/actions/contacts/${encodeURIComponent(email.trim().toLowerCase())}/regenerate-sequence`);
    await refreshContacts();
  };

  const tabButtons = useMemo(
    () =>
      (
        [
          ['contacts', 'Contacts'],
          ['intel', 'Company intelligence'],
          ['profiles', 'Company profiles'],
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

      <EnvBannerBar health={healthPreview} healthError={healthError} />

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
            <h2>Import spreadsheet (CSV / TSV)</h2>
            <p style={{ fontSize: '0.85rem', color: '#9aa0a6' }}>
              Columns map by <strong>header name</strong> (aliases supported). Paste from Excel / export CSV, or choose a
              file (max ~5&nbsp;MiB UTF-8, max 10&nbsp;000 data rows). Fully empty lines are ignored. Preview runs a
              dry-run; Import appends valid rows in file order (invalid and duplicate rows are skipped).
            </p>
            <div className="form-grid" style={{ marginBottom: '0.75rem' }}>
              <label>
                Delimiter
                <select
                  value={importDelimiter}
                  onChange={(e) => setImportDelimiter(e.target.value as 'auto' | 'tab' | 'comma')}
                >
                  <option value="auto">Auto (tab if first line contains tab, else comma)</option>
                  <option value="tab">Tab</option>
                  <option value="comma">Comma</option>
                </select>
              </label>
              <label style={{ alignSelf: 'end' }}>
                <span style={{ fontSize: '0.85rem', color: '#9aa0a6' }}>
                  UTF-8 bytes: {utf8ByteLength(importSpreadsheetText)} / {IMPORT_MAX_UTF8_BYTES} — est. data rows:{' '}
                  {estimatedDataRowsFromCsvText(importSpreadsheetText)}
                </span>
              </label>
            </div>
            <label>
              Paste CSV or TSV
              <textarea
                style={{ width: '100%', minHeight: 160, fontFamily: 'monospace', fontSize: '0.8rem' }}
                value={importSpreadsheetText}
                onChange={(e) => {
                  setImportSpreadsheetText(e.target.value);
                  setImportPreview(null);
                }}
              />
            </label>
            <div className="row-actions" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
              <input
                type="file"
                accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
                disabled={loading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) loadSpreadsheetFile(f);
                }}
              />
              <button
                type="button"
                className="secondary"
                disabled={loading}
                onClick={() => void runSpreadsheetImport(true)}
              >
                Preview
              </button>
              <button
                type="button"
                className="primary"
                disabled={loading}
                onClick={() => void runSpreadsheetImport(false)}
              >
                Import
              </button>
            </div>
            {importPreview ? (
              <div style={{ marginTop: '1rem' }}>
                <h3 style={{ fontSize: '1rem' }}>Last preview</h3>
                <pre style={{ fontSize: '0.75rem', overflow: 'auto', maxHeight: 200 }}>
                  {JSON.stringify(importPreview, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>

          <details className="panel">
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              Advanced: import JSON rows (legacy array body)
            </summary>
            <p style={{ fontSize: '0.85rem', color: '#9aa0a6' }}>
              POST <code>{'{"rows":[{ "email", "firstName", ...}], "dryRun"?: true }'}</code> — same limits and response
              shape as spreadsheet import.
            </p>
            <textarea
              style={{ width: '100%', minHeight: 140, fontFamily: 'monospace', fontSize: '0.8rem' }}
              value={importJson}
              onChange={(e) => {
                setImportJson(e.target.value);
                setImportPreview(null);
              }}
            />
            <div className="row-actions">
              <button type="button" className="secondary" disabled={loading} onClick={() => void runJsonImport(true)}>
                Preview JSON
              </button>
              <button type="button" className="primary" disabled={loading} onClick={() => void runJsonImport(false)}>
                Import JSON
              </button>
            </div>
          </details>
        </>
      ) : null}

      {tab === 'intel' ? (
        <>
          <div className="panel">
            <h2>Company intelligence (per contact)</h2>
            <p style={{ fontSize: '0.85rem', color: '#9aa0a6', marginTop: 0 }}>
              Links a contact to a canonical company URL and stores David / project notes. Shared research lives on the{' '}
              <strong>Company profiles</strong> tab.
            </p>
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
                    <th>Canonical URL</th>
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
                      <td title={String(r.canonicalCompanyUrl)}>{String(r.canonicalCompanyUrl).slice(0, 42)}</td>
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
                    ['canonicalCompanyUrl', 'Canonical company URL'],
                    ['companyUrl', 'Display company URL'],
                    ['davidProjectNotes', 'David / project notes'],
                    ['pipelineStatus', 'Pipeline status'],
                    ['generatedDate', 'Generated date'],
                    ['errorLog', 'Error log'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    {key === 'davidProjectNotes' || key === 'errorLog' ? (
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

      {tab === 'profiles' ? (
        <>
          <div className="panel">
            <h2>Company profiles (shared intelligence)</h2>
            <p style={{ fontSize: '0.85rem', color: '#9aa0a6', marginTop: 0 }}>
              One row per canonical website — researched once, reused by all contacts at that company. Patched by sheet
              row index.
            </p>
            <div className="row-actions">
              <button type="button" className="secondary" disabled={loading} onClick={() => void refreshProfiles()}>
                Refresh
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Canonical URL</th>
                    <th>Company</th>
                    <th>Pipeline</th>
                    <th>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {profileRows.map((r) => (
                    <tr
                      key={`${r.canonicalCompanyUrl}-${r._rowIndex}`}
                      className={selectedProfile?._rowIndex === r._rowIndex ? 'selected' : ''}
                      onClick={() => setSelectedProfile(r)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>{r._rowIndex}</td>
                      <td title={String(r.canonicalCompanyUrl)}>{String(r.canonicalCompanyUrl).slice(0, 36)}</td>
                      <td>{String(r.companyName)}</td>
                      <td>{String(r.pipelineStatus)}</td>
                      <td>{String(r.profileVersion)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {selectedProfile ? (
            <div className="panel">
              <h2>Edit company profile — row {selectedProfile._rowIndex}</h2>
              <p style={{ fontSize: '0.85rem', color: '#9aa0a6' }}>
                Canonical URL (column A) is read-only — create a new contact with the right <code>company_url</code> if
                the key must change.
              </p>
              <div className="form-grid">
                {(
                  [
                    ['companyUrl', 'Display URL'],
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
                    ['pipelineStatus', 'Pipeline status'],
                    ['researchedDate', 'Researched date'],
                    ['lastRefreshedAt', 'Last refreshed at'],
                    ['profileVersion', 'Profile version'],
                    ['errorLog', 'Error log'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    {key === 'signals' || key === 'alignmentRationale' || key === 'errorLog' ? (
                      <textarea
                        value={profileDraft[key] ?? ''}
                        onChange={(e) => setProfileDraft((d) => ({ ...d, [key]: e.target.value }))}
                      />
                    ) : (
                      <input
                        value={profileDraft[key] ?? ''}
                        onChange={(e) => setProfileDraft((d) => ({ ...d, [key]: e.target.value }))}
                      />
                    )}
                  </label>
                ))}
              </div>
              <div className="row-actions">
                <button type="button" className="primary" disabled={loading} onClick={() => void saveProfilePatch()}>
                  Save profile row
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
          <h2>Sequence actions</h2>
          <p style={{ fontSize: '0.85rem', color: '#9aa0a6', marginTop: 0 }}>
            Filter contacts below, then use <strong>Research again</strong> or <strong>Regenerate sequence</strong> per
            row. Pipeline actions need <code>PIPELINE_ENABLED=true</code> on the server. Send cycle returns 409 if a run
            is already in progress.
          </p>
          <ul style={{ fontSize: '0.8rem', color: '#b0b8c0', margin: '0 0 1rem 1.25rem', lineHeight: 1.5 }}>
            <li>
              <strong>Run send cycle:</strong> sends only when contacts are eligible per campaign timing (delay days,
              last_send_date, review status, etc.). Success with <code>sent: 0</code> often means nothing was due.
            </li>
            <li>
              <strong>Run pipeline cycle:</strong> advances <code>pipeline_status</code> buckets. Counts show how many
              contacts were examined; an existing company profile can be reused quietly.
            </li>
            <li>
              <strong>Research again:</strong> resets the contact to &quot;new&quot; and runs one pipeline pass. If the
              shared company profile already exists, sheets may look unchanged.
            </li>
            <li>
              <strong>Regenerate sequence:</strong> supersedes open review rows — most visible when you need new draft
              emails.
            </li>
          </ul>
          <div className="row-actions" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <label>
              Search (email, name, or company)
              <input
                type="text"
                value={sequenceFilterEmail}
                onChange={(e) => setSequenceFilterEmail(e.target.value)}
                placeholder="leave empty to show all contacts"
              />
            </label>
            <button type="button" className="secondary" disabled={loading} onClick={() => void refreshContacts()}>
              Refresh
            </button>
          </div>
          <p style={{ fontSize: '0.8rem', color: '#9aa0a6', margin: '0.75rem 0' }}>
            Global runs (all contacts / queue):
          </p>
          <div className="row-actions" style={{ marginBottom: '1rem' }}>
            <button type="button" className="primary" disabled={loading} onClick={() => void postAction('/actions/send-cycle')}>
              Run send cycle
            </button>
            <button type="button" className="secondary" disabled={loading} onClick={() => void postAction('/actions/pipeline-cycle')}>
              Run pipeline cycle
            </button>
            <button type="button" className="secondary" disabled={loading} onClick={() => void postAction('/actions/approval-watcher')}>
              Run approval watcher
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => void postAction('/actions/company-profile-refresh')}
            >
              Run company profile refresh
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Pipeline</th>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sequenceContactsFiltered.map((c) => {
                  const hasCompanyUrl = Boolean(String(c.companyUrl ?? '').trim());
                  return (
                    <tr key={c.email}>
                      <td>{c._rowIndex}</td>
                      <td>{c.email}</td>
                      <td>
                        {String(c.firstName)} {String(c.lastName)}
                      </td>
                      <td>{String(c.company)}</td>
                      <td>{String(c.pipelineStatus)}</td>
                      <td>{String(c.campaignId)}</td>
                      <td>{String(c.status)}</td>
                      <td>
                        <button
                          type="button"
                          className="primary"
                          disabled={loading || !hasCompanyUrl}
                          title={hasCompanyUrl ? 'Re-run research and alignment' : 'Set company_url on the contact first'}
                          onClick={() => void researchAgainForEmail(c.email)}
                        >
                          Research again
                        </button>{' '}
                        <button
                          type="button"
                          className="secondary"
                          disabled={loading}
                          title="Supersede open review rows and regenerate AI sequence (409 if review rows already have campaign_id)"
                          onClick={() => void regenerateSequenceForEmail(c.email)}
                        >
                          Regenerate sequence
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {sequenceContactsFiltered.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: '#9aa0a6' }}>
              {contacts.length === 0
                ? 'No contacts loaded yet. Click Refresh (save your API key first).'
                : 'No contacts match this search. Clear the filter or click Refresh.'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
