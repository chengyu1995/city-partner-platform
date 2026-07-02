# Hermes V3 Task Dispatch Rules

Scope: Phase 3A documentation only. These rules define how the Project Director decomposes approved demands and dispatches role-specific work. They do not implement dispatch code or modify Worker behavior.

## 1. How The Project Director Splits Tasks

The Project Director converts an approved demand into a tree:

1. Project: the business or system outcome.
2. Phase: a milestone with entry and exit conditions.
3. Task package: a role-owned deliverable that can be reviewed.
4. Subtask: the smallest executable unit for one Agent or Worker run.

Rules:

- Do not dispatch the project or phase directly to Codex.
- Split by role, risk, file boundary, and acceptance boundary.
- Keep product decisions before implementation.
- Keep UI/interaction design before frontend implementation when design affects layout or flow.
- Keep backend/API/data contracts before frontend integration when the frontend depends on them.
- Keep testing and operations as separate reviewable work.

## 2. Level Definitions

| Level | Definition | Executable | Required output |
| --- | --- | --- | --- |
| Project | Complete owner-visible outcome. | No | Project summary and final acceptance criteria. |
| Phase | Delivery milestone. | No | Phase goal, dependencies, exit criteria. |
| Task package | Reviewable role-owned work package. | Sometimes, but preferably split further. | Role deliverable and acceptance standard. |
| Subtask | Smallest executable work item. | Yes | Files/artifact, validation result, report. |

## 3. Product Manager Task Rules

Can do:

- Define MVP scope.
- Write user stories.
- Define success criteria.
- Decide information architecture at product level.
- Produce acceptance criteria and priority.

Cannot do:

- Implement UI or code.
- Approve production risk without boss.
- Add hidden scope not confirmed by boss.

Outputs:

- Product scope document.
- User flow summary.
- Acceptance criteria.
- Product risk list.

## 4. UI Designer Task Rules

Can do:

- Define visual direction, components, responsive layout, and page states.
- Produce mobile-first design notes.
- Specify visual hierarchy and empty/loading/error states.

Cannot do:

- Change code unless assigned as frontend implementation.
- Decide unconfirmed product scope.
- Ignore platform style rules.

Outputs:

- UI spec, screen list, component behavior, visual acceptance criteria.

## 5. Interaction Designer Task Rules

Can do:

- Define navigation, click paths, forms, validation behavior, and state transitions.
- Describe edge cases and user feedback.

Cannot do:

- Implement backend or frontend code.
- Change business rules without product approval.

Outputs:

- Interaction flow, state diagram, event/transition notes, acceptance checklist.

## 6. Frontend Developer Task Rules

Can do:

- Implement approved pages and components.
- Integrate approved mock or API contracts.
- Add focused frontend tests when in scope.
- Run lint, build, typecheck, and browser checks when applicable.

Cannot do:

- Import server-only modules in client components.
- Add dependencies without approval.
- Change backend contracts without coordination.
- Invent product scope not approved by boss.

Outputs:

- Modified frontend files.
- Validation results.
- Screenshots or preview notes when applicable.

## 7. Backend Developer Task Rules

Can do:

- Implement approved API/service/data-access changes.
- Preserve mock and real Supabase dual-mode rules.
- Add tests for data or API behavior.

Cannot do:

- Execute SQL or change database schema without separate approval.
- Change API contracts hidden from frontend/testing.
- Read or expose secrets.

Outputs:

- Backend code changes, API contract notes, validation results.

## 8. CMS/Admin Developer Task Rules

Can do:

- Implement approved admin screens, moderation flows, or content management forms.
- Separate admin permissions and user-facing behavior.

Cannot do:

- Create privileged production operations without approval.
- Modify auth/permission model without a high-risk gate.

Outputs:

- Admin/CMS files, permission notes, validation checklist.

## 9. Testing Engineer Task Rules

Can do:

- Define test plan.
- Run validation commands.
- Add focused tests.
- Verify mobile, responsive, state, API, and regression behavior.

Cannot do:

- Weaken tests to pass.
- Approve product changes.
- Deploy production.

Outputs:

- Test plan, test files when applicable, validation report, bug list.

## 10. Operations And Deployment Task Rules

Can do:

- Prepare deployment checklist.
- Inspect preview deployment status.
- Document rollback and monitoring.
- Coordinate production gate.

Cannot do:

- Trigger production deployment without explicit boss approval.
- Modify production environment variables.
- Change domains, secrets, or provider permissions automatically.

Outputs:

- Release checklist, rollback plan, deployment status report.

## 11. Role Permission Matrix

| Role | Can do | Cannot do |
| --- | --- | --- |
| Product | Scope, user stories, criteria | Code, production approval |
| UI | Visual spec and states | Backend, unapproved product scope |
| Interaction | Flow and behavior | Business rule changes |
| Frontend | Approved UI implementation | Backend/schema/secret changes |
| Backend | Approved service/API code | SQL execution or schema change without gate |
| CMS/Admin | Approved admin features | Privileged operations without gate |
| Testing | Validate and report | Weaken or delete tests |
| Operations | Preview/release planning | Production deploy without approval |

## 12. Required Subtask Fields

Every executable subtask must include:

- `title`
- `execution_role`
- `input`
- `output_files` or `output_artifact`
- `acceptance_criteria`
- `dependencies`
- `risk_level`
- `estimated_time`
- `allowed_scope`
- `forbidden_scope`
- `validation_method`
- `human_gate_required`

If any field is missing, the Project Director must not dispatch the subtask.

## 13. Tasks That Must Wait For Boss Confirmation

Wait for boss confirmation before:

- New website/product/feature/admin/login/publish/release scope.
- MVP versus complete-version choice.
- Any user-visible product flow change.
- Production deployment or rollback.
- Database schema, migration, backfill, deletion, or SQL execution.
- Supabase, Vercel, Feishu, GitHub workflow, Worker, API contract, dependency, `.env`, or `.gitignore` changes.
- Payment, mass messaging, secret, domain, permission, or data deletion changes.

## 14. Tasks That Can Be Automated

Automate only when:

- Boss approval already covers the scope or the task is narrow and direct.
- Risk level is low or accepted.
- Files are explicitly allowed.
- No product decision is pending.
- No forbidden system is touched.
- Validation is defined.

Examples:

- Create a documentation file under the approved path.
- Update copy in one approved component.
- Add a focused test for an approved bug fix.
- Run read-only validation commands.

## 15. Serial And Parallel Rules

Must be serial:

- Demand confirmation before task breakdown.
- Product scope before UI/interaction details.
- API/data contract before dependent frontend integration.
- Database design before migration implementation.
- Implementation before testing.
- Validation before acceptance.
- Production release after explicit gate.

Can be parallel:

- Independent design documents with separate output files.
- UI spec and backend contract only when product scope is stable.
- Frontend components touching different files after shared design is approved.
- Tests for independent modules.

Conflict rule: if two subtasks edit the same file, share an unresolved dependency, or require the same product decision, run them serially.

## 16. Dispatch Checklist

Before dispatch, Project Director verifies:

- Boss approval exists for the demand.
- Task tree has project, phase, task package, and subtask levels.
- Each subtask has required fields.
- Product, UI, frontend, backend, testing, and operations tasks are separated.
- High and critical risks are blocked behind human gates.
- Dependencies are acyclic.
- Parallel tasks do not edit the same files.
- Every subtask can be independently accepted.

If any check fails, keep the demand in planning or blocked state.
