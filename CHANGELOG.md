# Changelog

## [1.1.0](https://github.com/tonoid/agent-loop/compare/v1.0.0...v1.1.0) (2026-09-03)


### Features

* let a job opt out of the daily spawn cap ([#11](https://github.com/tonoid/agent-loop/issues/11)) ([4e3c3e0](https://github.com/tonoid/agent-loop/commit/4e3c3e02df0ce8aef9aa3f98ed79ce9c6d304ed8))
* let a job spend the reserve rather than miss its slot ([#14](https://github.com/tonoid/agent-loop/issues/14)) ([cfff85a](https://github.com/tonoid/agent-loop/commit/cfff85a4507122a309d32cbd159cd29bb020366d))
* put a clock on the holds that had none ([74007b3](https://github.com/tonoid/agent-loop/commit/74007b3ca1f40fa814bffe6eb937e17cc8ce7266))


### Bug Fixes

* a 429 from the usage endpoint is a burst limit, not an exhausted account ([5238f32](https://github.com/tonoid/agent-loop/commit/5238f32a59d4c1860f4484c0d223292e892b33ab))
* admit an account with no usage windows for one worker ([ffecd2a](https://github.com/tonoid/agent-loop/commit/ffecd2ade02a3092141ce601a9d0d1093283110b))
* answer startup dialogs on the option that is not a refusal ([7c12634](https://github.com/tonoid/agent-loop/commit/7c126342573e009247e624dbcabaf99f497b2605))
* answer the startup dialog a blocked agent waits on ([1d0ec50](https://github.com/tonoid/agent-loop/commit/1d0ec5061ae57271e38b579a33864836dc4d212f))
* carry a stale reading half an hour, and age it forward ([#6](https://github.com/tonoid/agent-loop/issues/6)) ([fd9e308](https://github.com/tonoid/agent-loop/commit/fd9e30867c869d944708bad911f36187a3deb7b1))
* price a stale reading only when the endpoint failed, not the account ([#8](https://github.com/tonoid/agent-loop/issues/8)) ([dd37674](https://github.com/tonoid/agent-loop/commit/dd37674bb44c6c5df41f61e6921dc45cf8ccaeac))
* price an account on its last reading when the endpoint refuses one ([#4](https://github.com/tonoid/agent-loop/issues/4)) ([db07165](https://github.com/tonoid/agent-loop/commit/db071656e71686e323d05bdf4931783718bc643f))
* read herdr's done status instead of collapsing it into missing ([#3](https://github.com/tonoid/agent-loop/issues/3)) ([f2896dd](https://github.com/tonoid/agent-loop/commit/f2896dd2b71e62d1dd57a9b00e56f64ed56ac313))
* release a worktree whose pull request a human now owns ([#10](https://github.com/tonoid/agent-loop/issues/10)) ([7166d69](https://github.com/tonoid/agent-loop/commit/7166d69469bb24c9c918f3efee922bf7b90e6c32))
* stop a closed pull request respawning its issue every tick ([#12](https://github.com/tonoid/agent-loop/issues/12)) ([f5b4048](https://github.com/tonoid/agent-loop/commit/f5b4048b4123a0eb754d500cdb294e27d7f921ef))
* sweep a failed builder, and keep a rotated refresh token ([#7](https://github.com/tonoid/agent-loop/issues/7)) ([f625217](https://github.com/tonoid/agent-loop/commit/f6252178d1d020ac217cf430ad720b53df0f1d96))
* tell workers to write absolute paths, not cd then relative ([#13](https://github.com/tonoid/agent-loop/issues/13)) ([91bc1cb](https://github.com/tonoid/agent-loop/commit/91bc1cb876aa732edeebcd487fab0f1bbc15bcbb))
* write a journal line when a tracked item fails ([#9](https://github.com/tonoid/agent-loop/issues/9)) ([a9d5bf6](https://github.com/tonoid/agent-loop/commit/a9d5bf63da4df844e1a71f8e0c4df214c78320e6))

## 1.0.0 (2026-08-20)


### Features

* agent-loop, a herdr-native scheduler for autonomous coding agents ([5f24551](https://github.com/tonoid/agent-loop/commit/5f2455165ddd2ccaec2f980ec00d2272890fa918))
