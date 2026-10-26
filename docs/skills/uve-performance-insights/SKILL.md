---
name: uve-performance-insights
description: Use the creator's cached Instagram results to propose testable editing variants while respecting metric coverage, missing data, and uncertainty.
metadata:
  version: "1.0.0"
---

# Performance-informed editing

Read the [Instagram tool reference](../../reference/tools/instagram.md). Begin with `instagram_accounts` to establish connection state, last sync, and post coverage. These tools read cached analytics; they do not sync, publish, schedule, or provide private credentials. Ask for a sync through the app only when stale or missing data prevents the requested comparison.

Use `instagram_posts` and, where needed, `instagram_post_analytics` to compare relevant posts. Respect `null` as unavailable and zero as measured zero. Metrics are observed lifetime totals, not automatically a selected week's performance. Coverage may exclude older posts; report the sample and observation dates.

Compare similar formats, lengths, topics, and time since publication where the evidence permits. Label rates with the exact numerator and denominator and omit them when a valid denominator is absent. Convert watch-time units according to the tool reference. Never fabricate retention curves or audience segments from view totals.

Inspect the corresponding media or project before attributing an edit characteristic to a post. A caption, thumbnail, or metric alone does not establish the opening shot, pacing, speaker, or editing technique. Distinguish observation, hypothesis, and recommendation. Correlation in a small sample cannot establish why a post performed well.

Translate a supported hypothesis into a controllable variant: a different opening line, shorter setup, alternative crop, or caption treatment. Preserve an existing cut and vary one main factor when practical. Describe the intended comparison and tradeoff without promising reach or virality.

Apply changes only within the requested editing scope. A request for insights does not authorize posting or scheduling. Save a preference as personal style only when the user adopts it as an ongoing choice, using [personal style](../uve-personal-style/SKILL.md).
