
<!-- Task logging convention (task-system) -->

## Task logging convention

This repo is tracked in the personal task system. The task id for this repo
lives in `.task_id` at the repo root.

After completing any meaningful unit of work (a commit, a defined subtask,
a bugfix), run:

    python3 ~/task-system/hooks/task_progress.py $(cat .task_id) "<one-line summary of what was just done>"

If the unit of work fully completes the task, add `--status completed`.

Do this automatically at the end of each such unit of work — don't wait to
be asked, and don't skip it because the change felt small. This is what
keeps the Scrum Tracker and personal dashboard accurate without Julian
touching either one.
