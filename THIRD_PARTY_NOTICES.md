# Third-party notices

Hybrid Subagents' delegation policy and reviewer instructions adapt the ideas and review criteria in Oh My Pi's `packages/coding-agent/src/prompts/tools/task.md` and `packages/coding-agent/src/prompts/agents/reviewer.md`, inspected on 2026-10-09. OMP-specific tools, schemas and execution protocols are not copied into Hybrid Subagents.

Source: https://github.com/can1357/oh-my-pi

## Oh My Pi — MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Runtime dependencies

Pi and pi-subagents are MIT-licensed upstream dependencies, not Hybrid Subagents forks.
Pi is provided by the host. pi-subagents is bundled unmodified in the published package (`bundleDependencies`), together with its own dependencies. Each bundled package keeps its license file under `node_modules/`.

- Pi 1.5.0: https://github.com/earendil-works/pi
- pi-subagents 0.87.0 (MIT, Copyright (c) 2026 Nico Bailon): https://github.com/nicobailon/pi-subagents
- Bundled with pi-subagents: jiti (MIT), undici (MIT), acorn (MIT), yaml (ISC), @js-temporal/polyfill (ISC), jsbi (Apache-2.0)
