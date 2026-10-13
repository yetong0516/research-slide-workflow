/** Public literature APIs. Bibliographic verification never verifies a figure or claim. */
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const EUROPE_PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const CROSSREF = 'https://api.crossref.org/works/';

const LIMITATIONS = [
  'Bibliographic metadata is not a check of study design, numerical claims, or figures.',
  'Check each scientific claim in the original article and record a page, figure, or table locator.',
  'A generated illustration is a schematic, not empirical evidence.',
  'An unknown or unconfirmed figure licence does not permit downloading and redistributing it.',
];

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}

function titleKey(value) {
  return cleanText(value).normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function yearOf(value) {
  const match = String(value ?? '').match(/\b((?:18|19|20|21)\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function normalizeDoi(value) {
  return String(value ?? '').trim().replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
}

function normalizePmid(value) {
  return String(value ?? '').trim().replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, '')
    .replace(/\/$/, '');
}

function validDoi(value) { return /^10\.\d{4,9}\/\S+$/i.test(value); }
function validPmid(value) { return /^\d+$/.test(value); }

function authorsOf(authors = []) {
  const list = Array.isArray(authors) ? authors : typeof authors === 'string' ? [authors] : [];
  return list.map((author) => typeof author === 'string' ? cleanText(author)
    : cleanText(author?.name ?? author?.fullName ?? [author?.given, author?.family].filter(Boolean).join(' ')))
    .filter(Boolean);
}

function authorIdentity(value) {
  const name = cleanText(value).replace(/\bet\s+al\.?$/i, '').trim();
  const tokens = name.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.length === 1) return { family: tokens[0].toLowerCase(), initials: '' };
  // Public APIs commonly use either "Given Family" or "Family AB".
  const initialsLast = /^[\p{Lu}]{1,4}$/u.test(tokens.at(-1));
  const familyTokens = initialsLast ? tokens.slice(0, -1) : tokens.slice(-1);
  const givenTokens = initialsLast ? [tokens.at(-1)] : tokens.slice(0, -1);
  return { family: familyTokens.join('').toLowerCase(), initials: givenTokens.map((token) =>
    /^[\p{Lu}]{1,4}$/u.test(token) ? token.toLowerCase() : token[0].toLowerCase()).join('') };
}

function identityFromFields(family, given) {
  if (!family || !given) return null;
  const initials = cleanText(given).replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean)
    .map((token) => /^[\p{Lu}]{1,4}$/u.test(token) ? token.toLowerCase() : token[0].toLowerCase()).join('');
  return { family: titleKey(family), initials };
}

function authorMatches(claimed, actual, authoritativeIdentity) {
  if (titleKey(claimed) === titleKey(actual)) return true;
  const left = authorIdentity(claimed), right = authoritativeIdentity ?? authorIdentity(actual);
  return Boolean(left && right && left.family === right.family && left.initials && right.initials
    && (left.initials.startsWith(right.initials) || right.initials.startsWith(left.initials)));
}

function journalKey(value) { return titleKey(value); }

function requireFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function (Node.js 20+ provides fetch).');
}

async function requestJson(url, fetchImpl) {
  const response = await fetchImpl(String(url), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!response?.ok) throw new Error(`Metadata request failed (HTTP ${response?.status ?? 'unknown'}).`);
  return response.json();
}

function pubmedUrl(endpoint, parameters, email) {
  const url = new URL(`${EUTILS}${endpoint}`);
  for (const [key, value] of Object.entries({ db: 'pubmed', retmode: 'json', tool: 'research-slide-workflow', ...parameters })) {
    url.searchParams.set(key, value);
  }
  if (email) url.searchParams.set('email', email);
  return url;
}

function pubmedRecord(doc) {
  const ids = Array.isArray(doc.articleids) ? doc.articleids : [];
  const pmid = String(doc.uid ?? ids.find((id) => id.idtype === 'pubmed')?.value ?? '');
  const doi = normalizeDoi(ids.find((id) => id.idtype === 'doi')?.value);
  return {
    id: `pubmed:${pmid}`, title: cleanText(doc.title), authors: authorsOf(doc.authors),
    year: yearOf(doc.pubdate) ?? yearOf(doc.epubdate), journal: cleanText(doc.fulljournalname ?? doc.source),
    journalAliases: [doc.fulljournalname, doc.source].map(cleanText).filter(Boolean),
    doi: doi || null, pmid: pmid || null, url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
    abstract: null,
  };
}

function crossrefRecord(message) {
  const dates = ['published', 'published-print', 'published-online', 'issued']
    .map((key) => message[key]?.['date-parts']?.[0]?.[0]).filter((year) => Number.isInteger(year));
  const doi = normalizeDoi(message.DOI);
  return {
    id: doi ? `doi:${doi}` : null, title: cleanText(message.title?.[0]), authors: authorsOf(message.author),
    firstAuthorIdentity: identityFromFields(message.author?.[0]?.family, message.author?.[0]?.given),
    year: dates[0] ?? null, yearCandidates: [...new Set(dates)],
    journal: cleanText(message['container-title']?.[0]), doi: doi || null, pmid: null,
    journalAliases: [...(message['container-title'] ?? []), ...(message['short-container-title'] ?? [])].map(cleanText).filter(Boolean),
    url: doi ? `https://doi.org/${doi}` : null, abstract: message.abstract ? cleanText(message.abstract) : null,
  };
}

function europePmcRecord(result) {
  const pmid = result.pmid ?? (result.source === 'MED' ? result.id : null);
  const doi = normalizeDoi(result.doi);
  return {
    id: pmid ? `pubmed:${pmid}` : doi ? `doi:${doi}` : `${result.source}:${result.id}`,
    title: cleanText(result.title), authors: authorsOf(result.authorList?.author ?? (result.authorString ? result.authorString.split(', ') : [])),
    firstAuthorIdentity: identityFromFields(result.authorList?.author?.[0]?.lastName,
      result.authorList?.author?.[0]?.firstName ?? result.authorList?.author?.[0]?.initials),
    year: yearOf(result.pubYear ?? result.firstPublicationDate),
    journal: cleanText(result.journalInfo?.journal?.title ?? result.journalTitle),
    journalAliases: [result.journalInfo?.journal?.title, result.journalInfo?.journal?.medlineAbbreviation,
      result.journalInfo?.journal?.isoAbbreviation, result.journalTitle].map(cleanText).filter(Boolean),
    doi: doi || null, pmid: pmid ? String(pmid) : null,
    url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : doi ? `https://doi.org/${doi}` : null,
    abstract: result.abstractText ? cleanText(result.abstractText) : null,
  };
}

function withDefaults(ref, verification) {
  const doi = normalizeDoi(ref.doi);
  const pmid = normalizePmid(ref.pmid);
  return {
    ...ref, id: ref.id ?? (pmid ? `pubmed:${pmid}` : doi ? `doi:${doi}` : null),
    title: cleanText(ref.title), authors: authorsOf(ref.authors), year: yearOf(ref.year), journal: cleanText(ref.journal),
    doi: doi || null, pmid: pmid || null,
    url: ref.url ?? (pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : doi ? `https://doi.org/${doi}` : null),
    abstract: ref.abstract ? cleanText(ref.abstract) : null,
    metadataVerified: verification.status === 'verified', verification,
    claims: Array.isArray(ref.claims) ? ref.claims.map((claim) => ({ ...claim })) : [],
    usage: { figureEvidence: 'unverified', license: 'unknown', ...ref.usage, downloadAllowed: false },
    limitations: [...new Set([...LIMITATIONS, ...(Array.isArray(ref.limitations) ? ref.limitations : [])])],
  };
}

/** Discover PubMed records. No claim, figure, or licence is verified by discovery. */
export async function discoverLiterature(topic, { limit = 6, email, fetchImpl = globalThis.fetch } = {}) {
  requireFetch(fetchImpl);
  if (typeof topic !== 'string' || !topic.trim()) throw new TypeError('topic must be a non-empty string.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be an integer between 1 and 100.');
  const searchUrl = pubmedUrl('esearch.fcgi', { term: topic.trim(), retmax: limit, sort: 'relevance' }, email);
  const search = await requestJson(searchUrl, fetchImpl);
  if (!Array.isArray(search.esearchresult?.idlist)) throw new Error('PubMed ESearch returned no valid idlist.');
  const ids = search.esearchresult.idlist.filter((id) => validPmid(String(id))).slice(0, limit);
  if (!ids.length) return [];
  const summaryUrl = pubmedUrl('esummary.fcgi', { id: ids.join(',') }, email);
  const summary = await requestJson(summaryUrl, fetchImpl);
  return ids.filter((id) => summary.result?.[id] && !summary.result[id].error).map((id) => {
    const record = pubmedRecord({ ...summary.result[id], uid: summary.result[id].uid ?? id });
    return withDefaults(record, {
      status: 'discovered', scope: 'bibliographic-metadata-only', checkedAt: new Date().toISOString(),
      checks: { title: 'not-checked', year: 'not-checked', doi: 'not-checked', pmid: 'not-checked', firstAuthor: 'not-checked', journal: 'not-checked' },
      issues: [], mismatches: [], sources: [{ provider: 'PubMed', url: String(summaryUrl), record }],
    });
  });
}

async function getSources(ref, fetchImpl) {
  const sources = [];
  const errors = [];
  const attempt = async (provider, url, readRecords) => {
    try {
      const records = readRecords(await requestJson(url, fetchImpl));
      if (!records.length) throw new Error('No matching metadata record was returned.');
      sources.push(...records.map((record) => ({ provider, url: String(url), record })));
    } catch (error) {
      errors.push({ type: 'unresolved', provider, url: String(url), reason: error.message });
    }
  };
  if (validDoi(ref.doi)) {
    const url = `${CROSSREF}${encodeURIComponent(ref.doi)}`;
    await attempt('Crossref', url, (data) => data.message?.DOI ? [crossrefRecord(data.message)] : []);
  }
  if (validPmid(ref.pmid)) {
    const url = pubmedUrl('esummary.fcgi', { id: ref.pmid });
    await attempt('PubMed', url, (data) => data.result?.[ref.pmid] && !data.result[ref.pmid].error
      ? [pubmedRecord({ ...data.result[ref.pmid], uid: data.result[ref.pmid].uid ?? ref.pmid })] : []);
  }
  if (validPmid(ref.pmid) || validDoi(ref.doi)) {
    const url = new URL(EUROPE_PMC);
    url.searchParams.set('query', validPmid(ref.pmid) ? `EXT_ID:${ref.pmid} AND SRC:MED` : `DOI:"${ref.doi}"`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('resultType', 'core');
    url.searchParams.set('pageSize', '10');
    await attempt('EuropePMC', url, (data) => (data.resultList?.result ?? []).map(europePmcRecord));
  }
  return { sources, errors };
}

/** Compare caller-supplied titles, years and identifiers with authoritative metadata. */
export async function verifyReferences(refs, { fetchImpl = globalThis.fetch } = {}) {
  requireFetch(fetchImpl);
  if (!Array.isArray(refs)) throw new TypeError('refs must be an array of reference objects.');
  const output = [];
  for (const input of refs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Each reference must be an object.');
    const ref = { ...input, title: cleanText(input.title), year: yearOf(input.year), doi: normalizeDoi(input.doi), pmid: normalizePmid(input.pmid) };
    const { sources, errors } = await getSources(ref, fetchImpl);
    const issues = [...errors];
    const checks = {};
    for (const field of ['title', 'year', 'doi', 'pmid']) {
      const expected = ref[field];
      if (!expected) {
        checks[field] = 'not-supplied';
        if (field === 'title' || field === 'year') issues.push({ type: 'unresolved', field, reason: `No claimed ${field} was supplied to compare.` });
        continue;
      }
      if ((field === 'doi' && !validDoi(expected)) || (field === 'pmid' && !validPmid(expected))) {
        checks[field] = 'unresolved';
        issues.push({ type: 'unresolved', field, expected, reason: 'Invalid identifier format.' });
        continue;
      }
      const candidates = sources.filter((source) => source.record[field] != null && source.record[field] !== '');
      if (!candidates.length) { checks[field] = 'unresolved'; continue; }
      const mismatched = candidates.filter((source) => field === 'title'
        ? titleKey(source.record.title) !== titleKey(expected) : String(source.record[field]) !== String(expected));
      checks[field] = mismatched.length ? 'mismatch' : 'match';
      issues.push(...mismatched.map((source) => ({ type: 'mismatch', field, expected,
        actual: source.record[field], provider: source.provider, url: source.url })));
    }
    const firstAuthor = authorsOf(input.authors)[0];
    const authorAuthorities = sources.filter((source) => source.record.authors?.length);
    if (!firstAuthor) checks.firstAuthor = 'not-supplied';
    else if (!authorAuthorities.length) checks.firstAuthor = 'unresolved';
    else {
      checks.firstAuthor = authorAuthorities.some((source) => authorMatches(firstAuthor, source.record.authors[0], source.record.firstAuthorIdentity)) ? 'match' : 'mismatch';
      if (checks.firstAuthor === 'mismatch') issues.push({ type: 'mismatch', field: 'firstAuthor', expected: firstAuthor,
        actual: authorAuthorities.map((source) => source.record.authors[0]), reason: 'The supplied first author does not match an authoritative first-author identity.' });
    }
    const claimedJournal = cleanText(input.journal);
    const journalAuthorities = [...new Set(sources.flatMap((source) => source.record.journalAliases ?? [source.record.journal]).filter(Boolean))];
    if (!claimedJournal) checks.journal = 'not-supplied';
    else if (!journalAuthorities.length) checks.journal = 'unresolved';
    else {
      checks.journal = journalAuthorities.some((journal) => journalKey(journal) === journalKey(claimedJournal)) ? 'match' : 'mismatch';
      if (checks.journal === 'mismatch') issues.push({ type: 'mismatch', field: 'journal', expected: claimedJournal,
        actual: journalAuthorities, reason: 'The supplied journal does not match an authoritative full or abbreviated journal name.' });
    }
    const mismatches = issues.filter((issue) => issue.type === 'mismatch');
    const identifiersSupplied = ['doi', 'pmid'].filter((field) => Boolean(ref[field]));
    const complete = sources.length > 0 && checks.title === 'match' && checks.year === 'match'
      && identifiersSupplied.length > 0 && identifiersSupplied.every((field) => checks[field] === 'match')
      && (!firstAuthor || checks.firstAuthor === 'match') && (!claimedJournal || checks.journal === 'match');
    const status = mismatches.length ? 'mismatch' : complete ? 'verified' : 'unresolved';
    if (!identifiersSupplied.length) issues.push({ type: 'unresolved', reason: 'Supply a DOI or PMID; title-only matching is not verification.' });
    const best = sources.find((source) => source.provider === 'EuropePMC')?.record ?? sources[0]?.record;
    // Missing fields may be filled, but the missing claimed field remains unresolved this run.
    const merged = { ...input };
    for (const field of ['id', 'title', 'authors', 'year', 'journal', 'doi', 'pmid', 'url', 'abstract']) {
      if ((merged[field] == null || merged[field] === '' || (Array.isArray(merged[field]) && !merged[field].length)) && best?.[field] != null) {
        merged[field] = best[field];
      }
    }
    // Render citations from authority metadata, not from an unchecked co-author list or journal spelling.
    const authoritativeAuthors = [best, ...sources.map((source) => source.record)].find((record) => record?.authors?.length)?.authors;
    const authoritativeJournal = [best, ...sources.map((source) => source.record)].find((record) => record?.journal)?.journal;
    if (authoritativeAuthors) merged.authors = authoritativeAuthors;
    if (authoritativeJournal) merged.journal = authoritativeJournal;
    output.push(withDefaults(merged, { status, scope: 'bibliographic-metadata-only', checkedAt: new Date().toISOString(),
      checks, issues, mismatches, sources,
      claimedBibliography: { authors: authorsOf(input.authors), journal: claimedJournal || null },
      authorCheckScope: 'first-author-identity-only; rendered author list comes from authority metadata' }));
  }
  return output;
}
