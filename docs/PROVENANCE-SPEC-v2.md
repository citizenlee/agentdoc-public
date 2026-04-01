# Provenance Specification v2.0

**Version:** 2.0.0
**Status:** Draft
**Last Updated:** 2026-01-11

## Overview

The Provenance Specification v2.0 defines a semantic, content-based system for tracking the origin and review status of text within documents. Unlike offset-based systems, v2.0 uses **semantic selectors** as the source of truth, allowing provenance to follow meaning rather than byte positions.

**Core Principle:** Attestation follows meaning, not bytes.

## Key Concepts

### Origin vs Basis vs Review

| Concept    | Definition                       | Values                               |
| ---------- | -------------------------------- | ------------------------------------ |
| **Origin** | Whose intellectual contribution  | `human` or `ai`                      |
| **Basis**  | Why AI wrote something (AI-only) | `described`, `inferred`, `suggested` |
| **Review** | Stack of verification actions    | Array of review records              |

**Critical Rule:** Basis is ONLY for AI-origin content. Human content never has a basis.

### The typed\_by Pattern

When the physical typist differs from the intellectual origin:

| Scenario                   | origin  | typed\_by   | basis       |
| -------------------------- | ------- | ----------- | ----------- |
| User types directly        | `human` | (omitted)   | (none)      |
| User dictates, AI types    | `human` | `ai:claude` | (none)      |
| AI writes from description | `ai`    | (omitted)   | `described` |
| AI infers from context     | `ai`    | (omitted)   | `inferred`  |
| AI proposes something      | `ai`    | (omitted)   | `suggested` |

## Schema Definition

### Document Structure

```yaml
version: "2.0"
conventions:
  - "https://example.com/proof/default.yaml"
  - "https://mycompany.com/custom-conventions.yaml"

document:
  fingerprint: "sha256:..."  # Full document hash for integrity

provenance:
  - <ProvenanceSpan>
  - <ProvenanceSpan>

rules:
  - <Rule>
```

### ProvenanceSpan

```yaml
selector: <Selector>            # Source of truth (required)
origin: human | ai              # Intellectual origin (required)
basis: described | inferred | suggested  # AI-only (optional)
basis_detail: "..."             # Free-text explanation (optional)
sources:                        # Attribution (optional)
  - <Source>
resolved:                       # Cached resolution (optional)
  offset: [start, end]
  content_hash: "sha256:..."
  resolved_at: "2025-01-11T14:00:00Z"
  status: valid | stale | missing
reviews:                        # Stack of reviews (required, may be empty)
  - <Review>
meta:                          # Metadata (optional)
  typed_by: "ai:claude"        # Who physically typed (if different from origin)
  inserted_by: "ai:claude"     # Who inserted
  inserted_at: "2025-01-11T14:00:00Z"
  model: "claude-opus-4-5"
```

### Selector Types

Selectors are "prompts to the agent" - natural language descriptions that Claude interprets to find content.

#### 1. Content Selector

Natural language description of the content.

```yaml
selector:
  content: "the paragraph explaining authentication"
```

Or with more detail:

```yaml
selector:
  content:
    description: "the paragraph explaining authentication"
    context: "in the Security section"
```

#### 2. Anchor Selector

Structural path through the document.

```yaml
selector:
  anchor: "heading:Authentication > paragraph:first"
```

```yaml
selector:
  anchor: "section:Legal > list:2 > item:3"
```

#### 3. Quote Selector

Exact text match.

```yaml
selector:
  quote: "The deadline is March 15, 2025."
```

With fuzzy matching:

```yaml
selector:
  quote:
    text: "The deadline is March 15, 2025"
    fuzzy: true
```

#### 4. Pattern Selector

CSS-like bulk matching.

```yaml
selector:
  pattern: "all blockquotes"
```

```yaml
selector:
  pattern: "code blocks containing 'function'"
```

#### 5. Composite Selector

Logical combinations.

```yaml
selector:
  all:
    - content: "introduction paragraph"
    - anchor: "section:Overview"
```

```yaml
selector:
  any:
    - quote: "March 15, 2025"
    - quote: "March 15th, 2025"
```

```yaml
selector:
  not:
    pattern: "all code blocks"
```

### Review

Reviews are a stack, not a single level. Multiple reviewers can review the same span.

```yaml
level: skimmed | flagged | approved
by: "ai:claude" | "human:alice"
at: "2025-01-11T14:00:00Z"
reviewed_hash: "sha256:..."      # Hash at time of review
notes: "Optional reviewer notes"
```

**Review Levels:**

| Level      | Who Can Add | Meaning                         |
| ---------- | ----------- | ------------------------------- |
| `skimmed`  | AI or Human | Quick read, basic check         |
| `flagged`  | Human only  | Needs attention/discussion      |
| `approved` | Human only  | Carefully reviewed and approved |

**Review Rules:**

1. AI cannot approve its own content (can only add `skimmed`)
2. Empty reviews = unreviewed
3. Reviews become **stale** when `reviewed_hash !== current content hash`
4. `getEffectiveReviewLevel()` returns highest non-stale review

### Source

Attribution for the content's origins.

```yaml
type: user_input | url | file | reference
content_hash: "sha256:..."  # Prefer hash over raw content
uri: "https://..."          # For url type
path: "/path/to/file"       # For file type
content: "raw text"         # Only when not sensitive
```

### Rule

Declarative patterns for bulk application.

```yaml
match: <Selector>
apply:
  origin: human
  # Can also pre-populate reviews
```

## Resolution Strategy

### Cache + Hash Verification

1. **Semantic selector** = source of truth
2. **Resolved offset + hash** = cached snapshot
3. On render: hash match → use cache (instant); mismatch → re-resolve (async)
4. Offline: use cached, mark stale spans visually

### Resolution Algorithm

```
resolve(selector, document) → ResolutionResult

1. Check if selector has resolved cache
2. If cached:
   a. Extract content at cached offset
   b. Compute hash of extracted content
   c. If hash matches → return cached (valid)
   d. If hash mismatches → mark stale, re-resolve
3. If not cached or stale:
   a. Call appropriate resolver based on selector type
   b. For quote: text search, fuzzy matching
   c. For anchor: parse document structure
   d. For content: call Claude API
   e. For pattern: regex + structural matching
   f. For composite: combine results logically
4. Store new resolution with hash
5. Return result with confidence score
```

### ResolutionResult

```yaml
matches:
  - offset: [100, 350]
    confidence: 0.95
    reason: "Exact quote match"
status: resolved | ambiguous | not_found
```

## Derived Attestation (for UI)

Convert review stack to human-readable level:

| Condition           | Display                                |
| ------------------- | -------------------------------------- |
| 3+ approved reviews | "Verified" (highest trust)             |
| 1+ approved reviews | "Approved"                             |
| Any flagged reviews | "Needs Review" (flag takes precedence) |
| Only skimmed        | "Skimmed"                              |
| No reviews          | "Unreviewed"                           |

## Author ID Format

Consistent format for all author/reviewer fields:

| Type  | Format                           | Examples                                 |
| ----- | -------------------------------- | ---------------------------------------- |
| AI    | `ai:model` or `ai:model:version` | `ai:claude`, `ai:claude:opus-4-5`        |
| Human | `human:name` or `human:email`    | `human:alice`, `human:alice@example.com` |

## Conventions System

Documents can reference external convention files for extensibility:

```yaml
conventions:
  - "https://example.com/proof/default.yaml"
  - "https://mycompany.com/proof-legal.yaml"
```

Custom conventions can add:

* New review levels: `legal_approved`, `fact_checked`

* New basis levels for domain-specific use

* New source types

* Custom selector types

**Later conventions override earlier ones.**

## Storage Format

### Embedded in Markdown

Provenance is embedded at the end of markdown files as YAML in an HTML comment:

```markdown
# Document Content

Your document text here...

<!-- PROVENANCE
version: "2.0"
document:
  fingerprint: "sha256:abc123..."
provenance:
  - selector:
      quote: "Your document text here..."
    origin: human
    reviews: []
-->
```

### Fallback

For backwards compatibility, JSON format is also supported:

```markdown
<!-- PROVENANCE
{"version":"2.0","provenance":[...]}
-->
```

## Migration from v2.0.0 (Offset-Based)

When loading documents with legacy offset-based provenance:

1. Extract content at stored offsets
2. Generate quote selectors from extracted content
3. Compute content hashes
4. Mark spans with `meta.migrated: true`
5. Store in new format on next save

## Decision Tree for AI

```
Did user provide exact text to insert?
  → origin: human
  → meta.typed_by: ai:claude  (you're the scribe)
  → No basis (humans are their own justification)

Did user describe what they want you to write?
  → origin: ai
  → basis: described
  → basis_detail: what user asked for

Are you inferring something from context?
  → origin: ai
  → basis: inferred
  → basis_detail: why you added it

Are you suggesting/proposing something?
  → origin: ai
  → basis: suggested
  → basis_detail: what you're proposing
```

## Complete Example

```yaml
version: "2.0"
conventions:
  - "https://example.com/proof/default.yaml"

document:
  fingerprint: "sha256:abc123def456..."

provenance:
  # AI-written content with reviews
  - selector:
      content: "the paragraph explaining authentication"
    origin: ai
    basis: described
    basis_detail: "User requested a project update"
    resolved:
      offset: [100, 350]
      content_hash: "sha256:abc123..."
      resolved_at: "2025-01-11T14:00:00Z"
      status: valid
    reviews:
      - level: skimmed
        by: "ai:claude"
        at: "2025-01-11T14:00:00Z"
        reviewed_hash: "sha256:abc123..."
        notes: "Self-checked for accuracy"
      - level: approved
        by: "human:dan"
        at: "2025-01-11T15:00:00Z"
        reviewed_hash: "sha256:abc123..."
    sources:
      - type: user_input
        content_hash: "sha256:def456..."
    meta:
      inserted_by: "ai:claude"
      inserted_at: "2025-01-11T14:00:00Z"
      model: "claude-opus-4-5"

  # Human-dictated content (AI typed it)
  - selector:
      quote: "The deadline is March 15, 2025."
    origin: human
    # No basis for human content
    resolved:
      offset: [351, 383]
      content_hash: "sha256:xyz789..."
      status: valid
    reviews: []  # Unreviewed
    meta:
      typed_by: "ai:claude"  # AI typed it but human origin

  # Flagged content needing attention
  - selector:
      anchor: "section:Legal > paragraph:first"
    origin: ai
    basis: suggested
    reviews:
      - level: flagged
        by: "human:alice"
        at: "2025-01-11T16:00:00Z"
        reviewed_hash: "sha256:..."
        notes: "Legal needs to review before publishing"

rules:
  - match:
      pattern: "all blockquotes"
    apply:
      origin: human
```

## Changelog

### v2.0.0 (Current)

* Introduced semantic selectors (content, anchor, quote, pattern, composite)

* Added resolution caching with hash verification

* Stacked review system replacing single attestation level

* Added `flagged` review level

* YAML format for provenance storage

* Conventions system for extensibility

* Clarified basis is AI-only; dictation uses `typed_by`

### v2.0.0-legacy (Offset-Based)

* Used offset-based spans (startOffset, endOffset)

* Single attestation level (A0-A4)

* JSON format only

* No semantic resolution
========================
========================

<!-- PROOF:END -->

<!-- PROVENANCE
{"spans":[{"spanId":"span_001","startOffset":1,"endOffset":30,"endLine":0,"authorId":"unknown","startLine":0,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_002","startOffset":32,"endOffset":46,"endLine":1,"authorId":"unknown","startLine":1,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_003","startOffset":47,"endOffset":60,"endLine":1,"authorId":"unknown","startLine":1,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_004","startOffset":61,"endOffset":85,"endLine":1,"authorId":"unknown","startLine":1,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_005","startOffset":87,"endOffset":95,"endLine":2,"authorId":"unknown","startLine":2,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_006","startOffset":97,"endOffset":387,"endLine":3,"authorId":"unknown","startLine":3,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_007","startOffset":389,"endOffset":444,"endLine":4,"authorId":"unknown","startLine":4,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_008","startOffset":446,"endOffset":458,"endLine":5,"authorId":"unknown","startLine":5,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_009","startOffset":460,"endOffset":485,"endLine":6,"authorId":"unknown","startLine":6,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_010","startOffset":490,"endOffset":497,"endLine":10,"authorId":"unknown","startLine":10,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_011","startOffset":501,"endOffset":511,"endLine":12,"authorId":"unknown","startLine":12,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_012","startOffset":515,"endOffset":521,"endLine":14,"authorId":"unknown","startLine":14,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_013","startOffset":527,"endOffset":533,"endLine":17,"authorId":"unknown","startLine":17,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_014","startOffset":537,"endOffset":568,"endLine":19,"authorId":"unknown","startLine":19,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_015","startOffset":572,"endOffset":583,"endLine":21,"authorId":"unknown","startLine":21,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_016","startOffset":589,"endOffset":594,"endLine":24,"authorId":"unknown","startLine":24,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_017","startOffset":598,"endOffset":630,"endLine":26,"authorId":"unknown","startLine":26,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_018","startOffset":634,"endOffset":664,"endLine":28,"authorId":"unknown","startLine":28,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_019","startOffset":670,"endOffset":676,"endLine":31,"authorId":"unknown","startLine":31,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_020","startOffset":680,"endOffset":709,"endLine":33,"authorId":"unknown","startLine":33,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_021","startOffset":713,"endOffset":736,"endLine":35,"authorId":"unknown","startLine":35,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_022","startOffset":741,"endOffset":825,"endLine":36,"authorId":"unknown","startLine":36,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_023","startOffset":827,"endOffset":847,"endLine":37,"authorId":"unknown","startLine":37,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_024","startOffset":849,"endOffset":911,"endLine":38,"authorId":"unknown","startLine":38,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_025","startOffset":916,"endOffset":924,"endLine":42,"authorId":"unknown","startLine":42,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_026","startOffset":928,"endOffset":934,"endLine":44,"authorId":"unknown","startLine":44,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_027","startOffset":938,"endOffset":946,"endLine":46,"authorId":"unknown","startLine":46,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_028","startOffset":950,"endOffset":955,"endLine":48,"authorId":"unknown","startLine":48,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_029","startOffset":961,"endOffset":980,"endLine":51,"authorId":"unknown","startLine":51,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_030","startOffset":984,"endOffset":989,"endLine":53,"authorId":"unknown","startLine":53,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_031","startOffset":993,"endOffset":1002,"endLine":55,"authorId":"unknown","startLine":55,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_032","startOffset":1006,"endOffset":1012,"endLine":57,"authorId":"unknown","startLine":57,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_033","startOffset":1018,"endOffset":1041,"endLine":60,"authorId":"unknown","startLine":60,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_034","startOffset":1045,"endOffset":1050,"endLine":62,"authorId":"unknown","startLine":62,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_035","startOffset":1054,"endOffset":1063,"endLine":64,"authorId":"unknown","startLine":64,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_036","startOffset":1067,"endOffset":1073,"endLine":66,"authorId":"unknown","startLine":66,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_037","startOffset":1079,"endOffset":1105,"endLine":69,"authorId":"unknown","startLine":69,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_038","startOffset":1109,"endOffset":1111,"endLine":71,"authorId":"unknown","startLine":71,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_039","startOffset":1115,"endOffset":1124,"endLine":73,"authorId":"unknown","startLine":73,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_040","startOffset":1128,"endOffset":1137,"endLine":75,"authorId":"unknown","startLine":75,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_041","startOffset":1143,"endOffset":1165,"endLine":78,"authorId":"unknown","startLine":78,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_042","startOffset":1169,"endOffset":1171,"endLine":80,"authorId":"unknown","startLine":80,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_043","startOffset":1175,"endOffset":1184,"endLine":82,"authorId":"unknown","startLine":82,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_044","startOffset":1188,"endOffset":1196,"endLine":84,"authorId":"unknown","startLine":84,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_045","startOffset":1202,"endOffset":1223,"endLine":87,"authorId":"unknown","startLine":87,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_046","startOffset":1227,"endOffset":1229,"endLine":89,"authorId":"unknown","startLine":89,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_047","startOffset":1233,"endOffset":1242,"endLine":91,"authorId":"unknown","startLine":91,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_048","startOffset":1246,"endOffset":1255,"endLine":93,"authorId":"unknown","startLine":93,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_049","startOffset":1260,"endOffset":1277,"endLine":94,"authorId":"unknown","startLine":94,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_050","startOffset":1279,"endOffset":1297,"endLine":95,"authorId":"unknown","startLine":95,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_051","startOffset":1604,"endOffset":1618,"endLine":97,"authorId":"unknown","startLine":97,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_052","startOffset":2467,"endOffset":2481,"endLine":99,"authorId":"unknown","startLine":99,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_053","startOffset":2483,"endOffset":2591,"endLine":100,"authorId":"unknown","startLine":100,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_054","startOffset":2593,"endOffset":2612,"endLine":101,"authorId":"unknown","startLine":101,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_055","startOffset":2614,"endOffset":2658,"endLine":102,"authorId":"unknown","startLine":102,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_056","startOffset":2724,"endOffset":2744,"endLine":104,"authorId":"unknown","startLine":104,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_057","startOffset":2866,"endOffset":2884,"endLine":106,"authorId":"unknown","startLine":106,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_058","startOffset":2886,"endOffset":2923,"endLine":107,"authorId":"unknown","startLine":107,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_059","startOffset":3044,"endOffset":3061,"endLine":110,"authorId":"unknown","startLine":110,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_060","startOffset":3063,"endOffset":3080,"endLine":111,"authorId":"unknown","startLine":111,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_061","startOffset":3136,"endOffset":3156,"endLine":113,"authorId":"unknown","startLine":113,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_062","startOffset":3237,"endOffset":3256,"endLine":115,"authorId":"unknown","startLine":115,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_063","startOffset":3258,"endOffset":3281,"endLine":116,"authorId":"unknown","startLine":116,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_064","startOffset":3381,"endOffset":3402,"endLine":119,"authorId":"unknown","startLine":119,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_065","startOffset":3404,"endOffset":3425,"endLine":120,"authorId":"unknown","startLine":120,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_066","startOffset":3647,"endOffset":3653,"endLine":124,"authorId":"unknown","startLine":124,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_067","startOffset":3655,"endOffset":3740,"endLine":125,"authorId":"unknown","startLine":125,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_068","startOffset":3929,"endOffset":3943,"endLine":127,"authorId":"unknown","startLine":127,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_069","startOffset":3948,"endOffset":3953,"endLine":131,"authorId":"unknown","startLine":131,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_070","startOffset":3957,"endOffset":3968,"endLine":133,"authorId":"unknown","startLine":133,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_071","startOffset":3972,"endOffset":3979,"endLine":135,"authorId":"unknown","startLine":135,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_072","startOffset":3985,"endOffset":3992,"endLine":138,"authorId":"unknown","startLine":138,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_073","startOffset":3996,"endOffset":4007,"endLine":140,"authorId":"unknown","startLine":140,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_074","startOffset":4011,"endOffset":4034,"endLine":142,"authorId":"unknown","startLine":142,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_075","startOffset":4040,"endOffset":4047,"endLine":145,"authorId":"unknown","startLine":145,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_076","startOffset":4051,"endOffset":4061,"endLine":147,"authorId":"unknown","startLine":147,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_077","startOffset":4065,"endOffset":4091,"endLine":149,"authorId":"unknown","startLine":149,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_078","startOffset":4097,"endOffset":4105,"endLine":152,"authorId":"unknown","startLine":152,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_079","startOffset":4109,"endOffset":4119,"endLine":154,"authorId":"unknown","startLine":154,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_080","startOffset":4123,"endOffset":4154,"endLine":156,"authorId":"unknown","startLine":156,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_081","startOffset":4159,"endOffset":4172,"endLine":157,"authorId":"unknown","startLine":157,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_082","startOffset":4176,"endOffset":4232,"endLine":160,"authorId":"unknown","startLine":160,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_083","startOffset":4236,"endOffset":4262,"endLine":162,"authorId":"unknown","startLine":162,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_084","startOffset":4266,"endOffset":4330,"endLine":164,"authorId":"unknown","startLine":164,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_085","startOffset":4334,"endOffset":4392,"endLine":166,"authorId":"unknown","startLine":166,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_086","startOffset":4396,"endOffset":4402,"endLine":167,"authorId":"unknown","startLine":167,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_087","startOffset":4404,"endOffset":4442,"endLine":168,"authorId":"unknown","startLine":168,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_088","startOffset":4687,"endOffset":4691,"endLine":170,"authorId":"unknown","startLine":170,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_089","startOffset":4693,"endOffset":4735,"endLine":171,"authorId":"unknown","startLine":171,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_090","startOffset":4813,"endOffset":4832,"endLine":173,"authorId":"unknown","startLine":173,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_091","startOffset":4834,"endOffset":4859,"endLine":174,"authorId":"unknown","startLine":174,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_092","startOffset":4863,"endOffset":4898,"endLine":177,"authorId":"unknown","startLine":177,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_093","startOffset":4902,"endOffset":4942,"endLine":179,"authorId":"unknown","startLine":179,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_094","startOffset":4946,"endOffset":5020,"endLine":181,"authorId":"unknown","startLine":181,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_095","startOffset":5024,"endOffset":5070,"endLine":183,"authorId":"unknown","startLine":183,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_096","startOffset":5074,"endOffset":5094,"endLine":184,"authorId":"unknown","startLine":184,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_097","startOffset":5746,"endOffset":5762,"endLine":186,"authorId":"unknown","startLine":186,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_098","startOffset":5891,"endOffset":5919,"endLine":188,"authorId":"unknown","startLine":188,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_099","startOffset":5921,"endOffset":5966,"endLine":189,"authorId":"unknown","startLine":189,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_100","startOffset":5971,"endOffset":5980,"endLine":193,"authorId":"unknown","startLine":193,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_101","startOffset":5984,"endOffset":5991,"endLine":195,"authorId":"unknown","startLine":195,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_102","startOffset":5997,"endOffset":6016,"endLine":198,"authorId":"unknown","startLine":198,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_103","startOffset":6020,"endOffset":6046,"endLine":200,"authorId":"unknown","startLine":200,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_104","startOffset":6052,"endOffset":6071,"endLine":203,"authorId":"unknown","startLine":203,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_105","startOffset":6075,"endOffset":6085,"endLine":205,"authorId":"unknown","startLine":205,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_106","startOffset":6091,"endOffset":6110,"endLine":208,"authorId":"unknown","startLine":208,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_107","startOffset":6114,"endOffset":6152,"endLine":210,"authorId":"unknown","startLine":210,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_108","startOffset":6158,"endOffset":6170,"endLine":213,"authorId":"unknown","startLine":213,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_109","startOffset":6174,"endOffset":6183,"endLine":215,"authorId":"unknown","startLine":215,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_110","startOffset":6189,"endOffset":6199,"endLine":218,"authorId":"unknown","startLine":218,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_111","startOffset":6203,"endOffset":6215,"endLine":220,"authorId":"unknown","startLine":220,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_112","startOffset":6220,"endOffset":6236,"endLine":221,"authorId":"unknown","startLine":221,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_113","startOffset":6238,"endOffset":6287,"endLine":222,"authorId":"unknown","startLine":222,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_114","startOffset":6292,"endOffset":6296,"endLine":226,"authorId":"unknown","startLine":226,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_115","startOffset":6300,"endOffset":6306,"endLine":228,"authorId":"unknown","startLine":228,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_116","startOffset":6310,"endOffset":6318,"endLine":230,"authorId":"unknown","startLine":230,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_117","startOffset":6324,"endOffset":6326,"endLine":233,"authorId":"unknown","startLine":233,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_118","startOffset":6330,"endOffset":6358,"endLine":235,"authorId":"unknown","startLine":235,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_119","startOffset":6362,"endOffset":6391,"endLine":237,"authorId":"unknown","startLine":237,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_120","startOffset":6397,"endOffset":6402,"endLine":240,"authorId":"unknown","startLine":240,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_121","startOffset":6406,"endOffset":6431,"endLine":242,"authorId":"unknown","startLine":242,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_122","startOffset":6435,"endOffset":6471,"endLine":244,"authorId":"unknown","startLine":244,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_123","startOffset":6476,"endOffset":6494,"endLine":245,"authorId":"unknown","startLine":245,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_124","startOffset":6496,"endOffset":6564,"endLine":246,"authorId":"unknown","startLine":246,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_125","startOffset":6700,"endOffset":6727,"endLine":248,"authorId":"unknown","startLine":248,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_126","startOffset":6731,"endOffset":6778,"endLine":251,"authorId":"unknown","startLine":251,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_127","startOffset":6782,"endOffset":6822,"endLine":253,"authorId":"unknown","startLine":253,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_128","startOffset":6826,"endOffset":6842,"endLine":255,"authorId":"unknown","startLine":255,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_129","startOffset":6846,"endOffset":6867,"endLine":257,"authorId":"unknown","startLine":257,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_130","startOffset":6871,"endOffset":6911,"endLine":258,"authorId":"unknown","startLine":258,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_131","startOffset":6913,"endOffset":6927,"endLine":259,"authorId":"unknown","startLine":259,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_132","startOffset":6929,"endOffset":6949,"endLine":260,"authorId":"unknown","startLine":260,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_133","startOffset":6951,"endOffset":7030,"endLine":261,"authorId":"unknown","startLine":261,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_134","startOffset":7262,"endOffset":7270,"endLine":263,"authorId":"unknown","startLine":263,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_135","startOffset":7272,"endOffset":7331,"endLine":264,"authorId":"unknown","startLine":264,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_136","startOffset":7391,"endOffset":7427,"endLine":266,"authorId":"unknown","startLine":266,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_137","startOffset":7429,"endOffset":7488,"endLine":267,"authorId":"unknown","startLine":267,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_138","startOffset":7492,"endOffset":7525,"endLine":270,"authorId":"unknown","startLine":270,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_139","startOffset":7529,"endOffset":7576,"endLine":272,"authorId":"unknown","startLine":272,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_140","startOffset":7580,"endOffset":7602,"endLine":274,"authorId":"unknown","startLine":274,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_141","startOffset":7606,"endOffset":7641,"endLine":276,"authorId":"unknown","startLine":276,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_142","startOffset":7645,"endOffset":7677,"endLine":278,"authorId":"unknown","startLine":278,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_143","startOffset":7681,"endOffset":7701,"endLine":279,"authorId":"unknown","startLine":279,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_144","startOffset":8213,"endOffset":8229,"endLine":281,"authorId":"unknown","startLine":281,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_145","startOffset":9994,"endOffset":10003,"endLine":283,"authorId":"unknown","startLine":283,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_146","startOffset":10005,"endOffset":10021,"endLine":284,"authorId":"unknown","startLine":284,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_147","startOffset":10025,"endOffset":10099,"endLine":287,"authorId":"unknown","startLine":287,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_148","startOffset":10103,"endOffset":10150,"endLine":289,"authorId":"unknown","startLine":289,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_149","startOffset":10154,"endOffset":10210,"endLine":291,"authorId":"unknown","startLine":291,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_150","startOffset":10214,"endOffset":10240,"endLine":293,"authorId":"unknown","startLine":293,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_151","startOffset":10244,"endOffset":10278,"endLine":295,"authorId":"unknown","startLine":295,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_152","startOffset":10282,"endOffset":10318,"endLine":297,"authorId":"unknown","startLine":297,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_153","startOffset":10322,"endOffset":10373,"endLine":299,"authorId":"unknown","startLine":299,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_154","startOffset":10377,"endOffset":10405,"endLine":300,"authorId":"unknown","startLine":300,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_155","startOffset":10409,"endOffset":10457,"endLine":303,"authorId":"unknown","startLine":303,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_156","startOffset":10461,"endOffset":10493,"endLine":305,"authorId":"unknown","startLine":305,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_157","startOffset":10497,"endOffset":10513,"endLine":307,"authorId":"unknown","startLine":307,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"},{"spanId":"span_158","startOffset":10517,"endOffset":10539,"endLine":309,"authorId":"unknown","startLine":309,"attestation":"A0","origin":"ai.generated","createdAt":"2026-01-12T01:22:14Z"}],"attention":{},"version":"2.0.0","events":[],"created":"2026-01-12T01:22:14Z","metadata":{"attestationCoverage":{"A0":1,"A2":0,"A1":0,"A4":0,"A3":0},"humanPercent":0,"aiPercent":100},"modified":"2026-01-12T01:22:14Z","documentId":"babe86d2-2453-43d9-937a-2379d60f143a"}
-->
