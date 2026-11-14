# Next updates for the desktop app

What is waiting, and what to do for each. Update this file in the same commit as the work it describes.
Last checked: 2026-11-14. The CLI and the site have their own `NEXT.md`.

## 1. Pandas on the empty screens

The phone app shows a panda when a list is empty: the one with a magnifying glass for agents, the builder for tools,
and the one on the phone for calls. The desktop app does not do this yet.

Do: use the same drawings. They are the owner's own art, so no licence entry is owed. Take them from
`lib/hub/ui/assets/` in ArcFlare-Code: they are cut-outs with a transparent background, so they work on both themes.
Look at each empty view in light and dark before committing ([rule 2](rules/02-verify-and-push.md)).

## 2. Old branches

Each is ahead of main and was never merged. Merge it, take what is still useful, or delete it:

| Branch | Last commit | What |
|---|---|---|
| `ccr-882eaf18-777klu` | 2026-10-11 | Shop tab; llama.cpp downloads itself on first run |
| `ccr-a9ce14bc-0u1fzk` | 2026-10-10 | Artifacts and design mode in Chat |
| `ccr-f1048945-e81rq0` | 2026-10-09 | Kitten TTS 0.8 in Speech |
| `claude/app-design-blog-model-optimization-0r2qmy` | 2026-11-12 | ArcFlare Lite, a separate small app in Rust |
| `claude/model-rules-governance-inor9w` | 2026-11-12 | Removes the old `rules/` copy and the push review |

ArcFlare Lite is a whole new app. Its licences ([rule 6](rules/06-licensing.md)) and where it would be downloaded
from need the owner's yes before it lands.

## 3. The next release

The app is at 0.5.0. When something user-visible lands: bump to 0.6.0 in its own commit, write the release notes,
update `/desktop` on the site, and write the post ([rule 3](rules/03-changelog.md), [rule 4](rules/04-blog.md)).
