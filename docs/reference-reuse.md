# Reference comparison

| Component | Source inspected | BONFIRE decision and evidence |
| --- | --- | --- |
| README and GitHub About | Parkrr ed481721 and Treckrr 646069ad, README.md and repository metadata | Adopt the centered original mark, English summary, live CI badge, screenshot, features, quick start, operations and licensing sections. The BONFIRE topics describe the online application. |
| CI and container security | Parkrr ed481721, .github/workflows/ci.yml | Adapt the checksum-verified Trivy release download to scan both BONFIRE images, generate SBOMs and gate on high and critical findings. |
| Authentication and backups | Parkrr ed481721, internal/auth and internal/backup; Treckrr 646069ad, internal/backup | Implement BONFIRE-specific sessions, roles and encrypted PostgreSQL recovery. The isolated test entry point is ops/accept-online.ps1. |
| Operations documentation | Household 9388e61e, README.md | Compare migration, backup, restore and role sections. Document BONFIRE-specific commands and environment requirements. |

The reference source trees and public About metadata were accessible. Reference projects maintain their own license files. BONFIRE has no project license file. Further source paths and earlier design decisions appear in the [reference notes](REFERENZEN.md).
