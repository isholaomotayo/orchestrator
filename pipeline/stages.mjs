export const STAGES = ['planner', 'designer', 'coder', 'tester', 'reviewer', 'handoff', 'reporter'];
export const CORE_STAGES = ['planner', 'coder', 'tester', 'reviewer'];
export const OPTIONAL_STAGES = ['designer', 'handoff', 'reporter'];
export const STAGE_ARTIFACT_FILES = {
  planner: 'specs.md',
  designer: 'design.md',
  coder: 'changes.md',
  tester: 'test_suite.md',
  reviewer: 'review_report.md',
  handoff: 'handoff.md',
  reporter: 'reporter.md',
};
