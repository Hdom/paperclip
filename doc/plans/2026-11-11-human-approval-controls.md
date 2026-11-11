# Human execution-stage decisions (fork adaptation)

This fork adapts the approval controls proposed in
[upstream PR #13986](https://github.com/paperclipai/paperclip/pull/13986)
to the installed source line. A native execution stage needs a status decision
and a non-empty decision note in the same request. A status dropdown alone
cannot satisfy that contract.

## User flow

The current human participant opens the task properties, reads the current plan
when present, enters a decision note, and chooses **Approve** or **Request
changes**. The UI uses the normal signed-in session. No temporary Board API key
or manual API request is needed. The controls do not confer decision authority
on a different user or an agent.

A decision is tied to the displayed stage, its status version and last decision, and the exact plan
revision (including the absence of a plan). Loading or failed plan reads must not
look like an absent plan. A refresh to a new stage or revision invalidates the
old decision draft. A failed submission retains the draft for correction.

## Consistency boundary

The server rechecks participant, pending stage, decision version, last decision, policy, and
plan revision under the issue transaction lock before changing the issue or
recording the decision. Plan creation, revision changes, restoration, and deletion
must serialize on the same issue lock. This includes absence-to-creation races.
A stale decision fails rather than being interpreted as a Board override.

Decision-specific preconditions do not authorize unrelated issue changes. Normal
company, task privacy, participant, and mutation checks still apply. The decision
and its audit evidence must identify the revision that was decided on.

## Separate approval systems

An execution-stage decision is not a `request_confirmation` response. Existing
plan-targeted confirmations retain their own stale-target checks and resolver
policy. Accepted-plan decomposition still requires its existing accepted-plan
interaction. This UI does not manufacture acceptance, remove an approval gate,
or authorize downstream deployment or other external actions.

## Verification scope

Use disposable data only. Cover approve and request changes, required notes,
wrong participant, no-plan and loaded-plan decisions, stale stage, recycled
stage, changed plan, deletion/restoration, two competing submissions, and errors.
Exercise the transaction boundary with a real disposable database in addition to
mocked route/component tests. Browser checks must distinguish UI fixtures from a
real signed-in server. Run token gates, type checks, tests, and the build; report
any unrun or failed checks explicitly.

No production deployment is part of this adaptation.
