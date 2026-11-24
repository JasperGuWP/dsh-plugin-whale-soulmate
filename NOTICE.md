# NOTICE / 版权与致谢声明

## Copyright / 版权

Copyright (c) 2026 JasperGuWP

本仓库源代码与文档以 [MIT License](./LICENSE) 发布。
Source code and documentation in this repository are released under the [MIT License](./LICENSE).

## Assets / 素材版权

| Path | Description | Notes |
|---|---|---|
| `assets/pet-winterboy-chibi/` | Q-version winter-boy desktop pet: PNG fallback frames + VP9-alpha WebM clips + `pet.json` | Original companion art shipped with this plugin. Please keep attribution when redistributing the skin pack. |
| `assets/小鲸.png` / `assets/小鲸-male.jpg` | Static whale avatar stills used by the floating widget / onboarding | Original art for this project. |
| `docs/readme-banner-v2.png` / `docs/social-preview-v2.png` | Seven-skin project cover composed from the original desktop-pet artwork | Original project artwork. Please keep attribution when redistributing. |

重新分发皮肤包或形象素材时，请保留本 NOTICE 与作者署名。
When redistributing skin packs or avatar stills, please keep this NOTICE and author credit.

## Third-party / References / 参考与致谢

本项目在设计与实现上参考、学习并感谢以下开源项目与社区实践
（**本仓库不包含其源码副本**；下列链接仅为致谢与参考）：

This project learns from and gratefully acknowledges the following open-source work
and community practice (**no third-party source trees are vendored here**):

| Project | Why we thank them / 致谢原因 |
|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | Host runtime — Cordis plugins, tools, systemPrompt, dual node/browser faces. |
| [JasperGuWP/dsh-plugin-schemes](https://github.com/JasperGuWP/dsh-plugin-schemes) | Five extension forms & publish conventions for DSH plugins. |
| [JasperGuWP/dsh-project-memory](https://github.com/JasperGuWP/dsh-project-memory) | Inlined `defineTool` / Schema pattern; file-backed memory inspiration. |
| [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | Transparent VP9-alpha desktop-pet video pipeline & production specs we aligned with. |
| Community DSH companions (`dsh-bili-whale`, `dsh-bili-scroll`, `dsh-fish-memory`, whale widgets, …) | UX lessons on zero-friction onboarding, Bilibili safety gates, and companion tone. |
| Karpathy-style LLM Wiki pattern | Structured Markdown wiki pages with `[[slug]]` links; Retain → Recall → Reflect memory loop. |
| Cordis / Schemastery ecosystem | Reversible plugin lifecycle & config schemas. |
| [soldair/node-qrcode](https://github.com/soldair/node-qrcode) | QR encoding dependency (`qrcode` npm package). |
| [Open-Meteo](https://open-meteo.com/) | Weather data for `soulmate_weather`（geocoding + forecast，免密钥）。Data by Open-Meteo.com, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the free API is for non-commercial use — commercial distributions should subscribe to an Open-Meteo plan. 天气数据来自 Open-Meteo（CC BY 4.0）；免费接口限非商业用途，商业分发请订阅其付费方案。 |

MBTI type labels appearing in the persona quiz are a **public typology vocabulary** used for UX only; they are not an endorsement of any proprietary assessment product.

Bilibili-related features call the public Bilibili Web APIs under the user's own authenticated session; this plugin does not redistribute Bilibili client binaries.

## Trademark note / 商标说明

“DeepSeek”、“Bilibili / 哔哩哔哩”等为各自权利人的商标或品牌标识。
本项目仅为兼容集成，与商标持有方无隶属或背书关系。

“DeepSeek”, “Bilibili”, and related marks belong to their respective owners.
This project is an independent integration and is not affiliated with or endorsed by those trademark holders.
