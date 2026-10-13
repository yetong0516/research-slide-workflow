import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverLiterature, verifyReferences } from '../src/evidence.mjs';

// Synthetic metadata fixtures: these are API-contract examples, not research evidence.
const DOI = '10.1234/example.2022.001';
const PMID = '12345678';
const TITLE = 'Immune biomarkers in a clinical cohort';
const reference = { id: 'example', title: TITLE, year: 2023, doi: DOI, pmid: PMID };
const fixtures = {
  search: { esearchresult: { idlist: [PMID], count: '1' } },
  summary: { result: { uids: [PMID], [PMID]: { uid: PMID, title: `${TITLE}.`, pubdate: '2023 Jan 10',
    fulljournalname: 'Example Journal', authors: [{ name: 'Researcher A' }],
    articleids: [{ idtype: 'pubmed', value: PMID }, { idtype: 'doi', value: DOI }] } } },
  crossref: { message: { DOI, title: [TITLE], author: [{ given: 'A', family: 'Researcher' }],
    published: { 'date-parts': [[2023, 1, 10]] }, created: { 'date-parts': [[2022, 12, 1]] },
    'container-title': ['Example Journal'] } },
  europe: { resultList: { result: [{ source: 'MED', id: PMID, pmid: PMID, doi: DOI, title: TITLE,
    pubYear: '2023', journalInfo: { journal: { title: 'Example Journal' } },
    authorList: { author: [{ fullName: 'Researcher A' }] }, abstractText: '<p>A synthetic abstract.</p>' }] } },
};

function mockFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const key = String(url).includes('esearch.fcgi') ? 'search'
      : String(url).includes('esummary.fcgi') ? 'summary'
        : String(url).includes('api.crossref.org') ? 'crossref' : 'europe';
    const body = Object.hasOwn(overrides, key) ? overrides[key] : fixtures[key];
    if (body instanceof Error) throw body;
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  return { fetchImpl, calls };
}

test('discovery uses real PubMed ESearch + ESummary URLs and leaves empirical claims unverified', async () => {
  const mock = mockFetch();
  const [record] = await discoverLiterature('immune biomarkers', { limit: 3, email: 'contact@example.org', fetchImpl: mock.fetchImpl });
  assert.equal(mock.calls.length, 2);
  const search = new URL(mock.calls[0]);
  assert.equal(search.hostname, 'eutils.ncbi.nlm.nih.gov');
  assert.equal(search.searchParams.get('db'), 'pubmed');
  assert.equal(search.searchParams.get('term'), 'immune biomarkers');
  assert.equal(search.searchParams.get('retmax'), '3');
  assert.equal(search.searchParams.get('email'), 'contact@example.org');
  assert.equal(record.title, `${TITLE}.`);
  assert.equal(record.year, 2023);
  assert.equal(record.pmid, PMID);
  assert.equal(record.doi, DOI);
  assert.equal(record.abstract, null);
  assert.equal(record.metadataVerified, false);
  assert.equal(record.verification.status, 'discovered');
  assert.deepEqual(record.claims, []);
  assert.equal(record.usage.license, 'unknown');
  assert.equal(record.usage.downloadAllowed, false);
});

test('empty PubMed search is an empty result and does not request ESummary', async () => {
  const mock = mockFetch({ search: { esearchresult: { idlist: [] } } });
  assert.deepEqual(await discoverLiterature('empty query', { fetchImpl: mock.fetchImpl }), []);
  assert.equal(mock.calls.length, 1);
});

test('discovery validates topic, limit and malformed provider results', async () => {
  await assert.rejects(discoverLiterature(''), /non-empty/);
  await assert.rejects(discoverLiterature('topic', { limit: 0 }), /between 1 and 100/);
  await assert.rejects(discoverLiterature('topic', { limit: 101 }), /between 1 and 100/);
  await assert.rejects(discoverLiterature('topic', { fetchImpl: mockFetch({ search: {} }).fetchImpl }), /idlist/);
  await assert.rejects(discoverLiterature('topic', { fetchImpl: mockFetch({ search: null }).fetchImpl }), /HTTP 404/);
});

test('verification compares supplied title, year, DOI and PMID, without approving claims or figures', async () => {
  const mock = mockFetch();
  const claim = { id: 'claim-1', text: 'A number still needs source checking.', type: 'numerical', status: 'unverified' };
  const input = { ...reference, claims: [claim] };
  const [record] = await verifyReferences([input], { fetchImpl: mock.fetchImpl });
  assert.equal(record.verification.status, 'verified');
  assert.equal(record.metadataVerified, true);
  assert.deepEqual(record.verification.checks, { title: 'match', year: 'match', doi: 'match', pmid: 'match', firstAuthor: 'not-supplied', journal: 'not-supplied' });
  assert.deepEqual(record.verification.sources.map((source) => source.provider), ['Crossref', 'PubMed', 'EuropePMC']);
  assert.equal(record.verification.scope, 'bibliographic-metadata-only');
  assert.equal(record.abstract, 'A synthetic abstract.');
  assert.equal(record.usage.downloadAllowed, false);
  assert.equal(record.claims[0].status, 'unverified');
  assert.deepEqual(input, { ...reference, claims: [claim] });
});

test('a resolving DOI with the wrong claimed title is a mismatch, not verified', async () => {
  const [record] = await verifyReferences([{ ...reference, title: 'An unrelated study' }], { fetchImpl: mockFetch().fetchImpl });
  assert.equal(record.metadataVerified, false);
  assert.equal(record.verification.status, 'mismatch');
  assert.equal(record.verification.checks.title, 'mismatch');
  assert(record.verification.mismatches.some((issue) => issue.field === 'title' && issue.actual.startsWith(TITLE)));
});

test('year is verified from publication metadata, not DOI suffix or Crossref creation date', async () => {
  const [record] = await verifyReferences([{ ...reference, year: 2022 }], { fetchImpl: mockFetch().fetchImpl });
  assert.equal(record.verification.status, 'mismatch');
  assert.equal(record.verification.checks.year, 'mismatch');
  assert(record.verification.mismatches.every((issue) => issue.field !== 'year' || issue.actual === 2023));
});

test('a DOI/PMID pair referring to different articles is detected', async () => {
  const differentDoi = '10.1234/different.001';
  const crossref = structuredClone(fixtures.crossref);
  crossref.message.DOI = differentDoi;
  const [record] = await verifyReferences([{ ...reference, doi: differentDoi }], {
    fetchImpl: mockFetch({ crossref }).fetchImpl,
  });
  assert.equal(record.verification.status, 'mismatch');
  assert.equal(record.verification.checks.doi, 'mismatch');
});

test('conflicting PubMed UID cannot be hidden by the requested PMID', async () => {
  const summary = structuredClone(fixtures.summary);
  summary.result[PMID].uid = '87654321';
  const [record] = await verifyReferences([reference], { fetchImpl: mockFetch({ summary }).fetchImpl });
  assert.equal(record.verification.status, 'mismatch');
  assert.equal(record.verification.checks.pmid, 'mismatch');
});

test('transport failures are unresolved when no authoritative record resolves', async () => {
  const [record] = await verifyReferences([reference], {
    fetchImpl: mockFetch({ crossref: null, summary: new Error('Service unavailable'), europe: null }).fetchImpl,
  });
  assert.equal(record.verification.status, 'unresolved');
  assert.equal(record.metadataVerified, false);
  assert.equal(record.verification.sources.length, 0);
  assert(record.verification.issues.some((issue) => issue.reason.includes('Service unavailable')));
});

test('Europe PMC can provide bibliographic verification when Crossref is unavailable', async () => {
  const [record] = await verifyReferences([{ title: TITLE, year: 2023, doi: DOI }], {
    fetchImpl: mockFetch({ crossref: null }).fetchImpl,
  });
  assert.equal(record.verification.status, 'verified');
  assert.equal(record.pmid, PMID);
  assert(record.verification.issues.some((issue) => issue.provider === 'Crossref'));
});

test('DOI existence alone and a missing claimed year do not verify a reference', async () => {
  const [record] = await verifyReferences([{ doi: DOI }], { fetchImpl: mockFetch().fetchImpl });
  assert.equal(record.verification.status, 'unresolved');
  assert.equal(record.metadataVerified, false);
  assert.equal(record.title, TITLE); // Filled metadata is not a comparison of an absent claimed title.
  assert.equal(record.verification.checks.title, 'not-supplied');
  assert.equal(record.verification.checks.year, 'not-supplied');
});

test('invalid or missing identifiers cause no network lookup and remain unresolved', async () => {
  const mock = mockFetch();
  const results = await verifyReferences([{ title: TITLE, year: 2023, doi: 'not-a-doi' }, { title: TITLE, year: 2023 }], { fetchImpl: mock.fetchImpl });
  assert(results.every((record) => record.verification.status === 'unresolved'));
  assert.equal(mock.calls.length, 0);
});

test('resolver URLs, DOI case, and cosmetic title punctuation are normalized', async () => {
  const [record] = await verifyReferences([{ ...reference, title: `${TITLE.toUpperCase()}!`, doi: `https://doi.org/${DOI.toUpperCase()}` }], {
    fetchImpl: mockFetch().fetchImpl,
  });
  assert.equal(record.verification.status, 'verified');
  assert.equal(record.doi, DOI);
});

test('metadata verification does not grant image redistribution, including caller flags', async () => {
  const [record] = await verifyReferences([{ ...reference, usage: { license: 'unknown', downloadAllowed: true } }], {
    fetchImpl: mockFetch().fetchImpl,
  });
  assert.equal(record.usage.downloadAllowed, false);
  assert.equal(record.usage.figureEvidence, 'unverified');
});

test('a false first author is reported as mismatch and is not rendered as authority metadata', async () => {
  const [record] = await verifyReferences([{ ...reference, authors: ['Unrelated Person'] }], { fetchImpl: mockFetch().fetchImpl });
  assert.equal(record.verification.status, 'mismatch');
  assert.equal(record.verification.checks.firstAuthor, 'mismatch');
  assert.deepEqual(record.authors, ['Researcher A']);
  assert.deepEqual(record.verification.claimedBibliography.authors, ['Unrelated Person']);
});

test('first-author order and initials are supported, while the rendered co-author list comes from authority', async () => {
  const [record] = await verifyReferences([{ ...reference, authors: ['A Researcher', 'A fake unverified coauthor'] }], { fetchImpl: mockFetch().fetchImpl });
  assert.equal(record.verification.status, 'verified');
  assert.equal(record.verification.checks.firstAuthor, 'match');
  assert.deepEqual(record.authors, ['Researcher A']);
  assert.match(record.verification.authorCheckScope, /first-author-identity-only/);
});

test('false journal names are mismatches and the authoritative journal is filled', async () => {
  const [record] = await verifyReferences([{ ...reference, journal: 'Unrelated Journal' }], { fetchImpl: mockFetch().fetchImpl });
  assert.equal(record.verification.status, 'mismatch');
  assert.equal(record.verification.checks.journal, 'mismatch');
  assert.equal(record.journal, 'Example Journal');
});

test('a recognised journal abbreviation can match the authority alias set', async () => {
  const summary = structuredClone(fixtures.summary);
  summary.result[PMID].source = 'Ex J';
  const [record] = await verifyReferences([{ ...reference, journal: 'Ex. J.' }], { fetchImpl: mockFetch({ summary }).fetchImpl });
  assert.equal(record.verification.status, 'verified');
  assert.equal(record.verification.checks.journal, 'match');
  assert.equal(record.journal, 'Example Journal');
});

test('missing author and journal fields are filled from authority records', async () => {
  const [record] = await verifyReferences([reference], { fetchImpl: mockFetch().fetchImpl });
  assert.deepEqual(record.authors, ['Researcher A']);
  assert.equal(record.journal, 'Example Journal');
  assert.equal(record.verification.status, 'verified');
});

test('Crossref structured family names preserve surname prefixes during first-author comparison', async () => {
  const crossref = structuredClone(fixtures.crossref);
  crossref.message.author = [{ given: 'Pat', family: 'van der Example' }];
  const [record] = await verifyReferences([{ title: TITLE, year: 2023, doi: DOI, authors: ['van der Example P'] }], {
    fetchImpl: mockFetch({ crossref, europe: null }).fetchImpl,
  });
  assert.equal(record.verification.status, 'verified');
  assert.equal(record.verification.checks.firstAuthor, 'match');
  assert.deepEqual(record.authors, ['Pat van der Example']);
});
