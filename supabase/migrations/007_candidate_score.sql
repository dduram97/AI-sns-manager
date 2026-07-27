-- Phase 3-2: candidate scoring for discovery → neighbor_request gating

alter table public.discovery_candidates
  add column if not exists candidate_score integer;

create index if not exists discovery_candidates_score_idx
  on public.discovery_candidates (candidate_score desc nulls last, discovered_at desc);

comment on column public.discovery_candidates.candidate_score is
  'Phase 3-2: 0–100 score from recency + post activity + keyword relevance';
