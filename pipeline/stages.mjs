export const STAGES = ['planner', 'plan_reviewer', 'designer', 'coder', 'tester', 'reviewer', 'handoff', 'reporter'];
export const CORE_STAGES = ['planner', 'coder', 'tester', 'reviewer'];
export const OPTIONAL_STAGES = ['plan_reviewer', 'designer', 'handoff', 'reporter'];
export const STAGE_ARTIFACT_FILES = {
  planner: 'specs.md',
  plan_reviewer: 'plan_review.md',
  designer: 'design.md',
  coder: 'changes.md',
  tester: 'test_suite.md',
  reviewer: 'review_report.md',
  handoff: 'handoff.md',
  reporter: 'reporter.md',
};
