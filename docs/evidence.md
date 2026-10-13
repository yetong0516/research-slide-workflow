# Literature discovery and verification

`src/evidence.mjs` uses public PubMed, Crossref, and Europe PMC APIs. It requires Node.js 20 or newer and has no private connectors, account credentials, or package dependencies. The fixtures in `tests/evidence.test.mjs` are synthetic and run without network access.

## Public API

```js
import { discoverLiterature, verifyReferences } from '../src/evidence.mjs';

const discovered = await discoverLiterature('sepsis AND immune phenotype', {
  limit: 6,
  email: 'your-contact-address@example.org', // Optional NCBI contact address; use your own.
});
const verified = await verifyReferences(discovered);
const evidence = { topic: 'Sepsis and immune phenotype', sources: verified };
```

Both functions return an array. Both accept `fetchImpl` for fixture tests or an application-managed fetch implementation. No request is sent to a URL supplied in a reference: the implementation uses fixed, public provider endpoints. Each request has a 20-second timeout. Requests are sequential; there is no automatic retry. A live application should respect provider rate limits, cache responses, and retry a reported service failure later.

`discoverLiterature(topic, { limit = 6, email, fetchImpl })` calls PubMed ESearch, then ESummary. `topic` must be nonempty and `limit` an integer from 1 to 100. The returned records are candidates, not an exhaustive systematic search. PubMed ESummary does not supply an abstract, so discovery returns `abstract: null`. An empty search returns an empty array; malformed or failed discovery requests throw.

`verifyReferences(refs, { fetchImpl })` accepts reference objects. It resolves an available DOI through Crossref, an available PMID through PubMed ESummary, and the identifier through Europe PMC's core search response. It compares the caller's title, publication year, DOI, and PMID against the returned metadata. If supplied, the first author and journal name are checked too. A title-only search is not treated as verification. Cosmetic differences in title case, punctuation, diacritics, or HTML markup are normalized; changed title words are not fuzzy matched. Publication dates are used, not the DOI suffix, acceptance date, or Crossref record creation date.

The author comparison checks the **first author's identity**, supporting `Family Initials` and `Given Family` forms; it does not claim to verify every co-author, author order after the first author, affiliation, or contribution. Structured provider family names preserve surname prefixes where available. Journal names are compared against the authority set of full and abbreviated names returned by the providers; the code does not guess arbitrary abbreviations. Incorrect supplied first-author or journal values yield `mismatch`. Output author lists and journal names are taken from authority metadata; the original assertions remain in `verification.claimedBibliography` for audit. Missing author/journal fields are filled when an authoritative record supplies them.

## Record contract

```js
{
  id: 'pubmed:12345678',
  title: 'A caller-supplied or retrieved article title',
  authors: ['Researcher A'],
  year: 2023,
  journal: 'Example Journal',
  doi: '10.1234/example.001',
  pmid: '12345678',
  url: 'https://pubmed.ncbi.nlm.nih.gov/12345678/',
  abstract: null, // Text if available from a verification provider; otherwise null.
  metadataVerified: false,
  verification: {
    status: 'discovered', // discovered | verified | mismatch | unresolved
    scope: 'bibliographic-metadata-only',
    checkedAt: 'ISO timestamp',
    checks: { title: 'not-checked', year: 'not-checked', doi: 'not-checked', pmid: 'not-checked', firstAuthor: 'not-checked', journal: 'not-checked' },
    issues: [],
    mismatches: [],
    sources: [] // Each item: { provider, url, record: retrievedMetadata }.
  },
  claims: [],
  usage: {
    figureEvidence: 'unverified',
    license: 'unknown',
    downloadAllowed: false
  },
  limitations: []
}
```

Verification checks use `match`, `mismatch`, `unresolved`, or `not-supplied`. `verified` requires a comparison of both the supplied title and year plus every supplied identifier against at least one authoritative record, and any supplied first-author/journal assertions must match too. An unavailable optional provider is retained in `issues`; another provider can still establish the metadata comparison. Any returned contradiction produces `mismatch`, even when the DOI itself resolves. A missing claimed title/year, missing identifier, invalid identifier, or wholly unavailable metadata produces `unresolved`. Missing authors/journal are filled from authority metadata and do not alone block identity verification.

Missing bibliographic fields may be filled from retrieved metadata, but this does not change an absent comparison into a successful comparison in that run. The supplied title/year are retained when mismatched; the provider's conflicting values are available in `verification.mismatches` and `verification.sources`. Inspect discrepancies instead of silently replacing a reference. Online and issue publication years can differ, and provider metadata can itself be wrong; resolve this in the original publisher record and document the choice.

## Independent scientific evidence check

Discovering a real article and verifying its metadata are separate from checking what its figures and numbers support. A renderer must not use `metadataVerified: true` as permission to present an empirical claim as confirmed.

Add a claim only after a human or an AI has inspected the original paper and retained a precise locator. For AI checks, retain enough information for human review: the relevant figure/table/page, group definitions, denominators, timing, endpoint, units, and study limitations. A minimal claim contract is:

```js
{
  id: 'claim-1',
  heading: 'Short noun heading', // Must match the evidence card heading.
  text: 'The study reported this result in this population.', // Must match the card caption.
  reviewed: true,
  reviewer: 'Named reviewer or AI source review',
  reviewNote: 'Record the original source check, applicability and limitations.',
  type: 'numerical', // numerical | figure | narrative
  status: 'checked', // unverified | checked
  locator: 'Figure 2B; Table 4; PDF p. 6',
  sourceIds: ['pubmed:12345678'],
  checkedBy: 'human', // Or AI, with a reviewable record of the check.
  limitations: ['Single-centre observational cohort; not an incremental-performance test.']
}
```

The metadata functions pass existing `claims` through; they never promote a claim's status. A figure panel must independently link its local path, reference ID, original figure/panel locator, source URL, and checked licence. Replotting published table values should preserve denominators, units and uncertainty, and be labelled as a redraw from the source. Do not invent points or reconstruct a curve without labelling the extraction method. Do not turn a subgroup diagnostic AUC into an all-patient diagnostic AUC or a mortality-prediction result.

## Image permission and schematics

This module does not download original figures. Its output always sets `usage.downloadAllowed: false`: a metadata check cannot establish image-reuse permission. A record may retain an independently recorded licence assertion, but the actual article and each figure's credit line must be checked before download or redistribution. Unknown permission means keep a source link or a placeholder. A Crossref licence field or an open-access flag alone does not establish rights for every third-party image.

AI-generated illustrations can explain mechanisms or show a planned workflow. Label them as schematics. They must not stand in for a paper figure, patient observation, measured distribution, or completed analysis. A planned project panel should describe the planned analysis, not display invented findings.

## Testing and provider documentation

```sh
node --test tests/evidence.test.mjs
```

The tests cover real endpoint construction, metadata mismatch detection, DOI/PMID disagreement, publication-year handling, first-author and journal mismatches, surname prefixes and recognised journal abbreviations, failed providers, missing claimed fields, and the separation of metadata, claims, and image rights.

Provider documentation: [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25499/), [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/), and [Europe PMC REST API](https://europepmc.org/RestfulWebService). Abstracts can have separate copyright restrictions; inspect their reuse terms before reproducing them publicly.
