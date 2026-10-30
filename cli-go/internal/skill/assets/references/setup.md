# Native setup and authorization

Install the signed or checksum-verified native `muvloom` release for the current operating system and architecture using the product's release instructions. Do not assume Node.js, npm, or npx is installed. If a package manager is already available, it MAY be used to install the native binary; never replace the native binary flow with a JavaScript client.

After installation, verify with `muvloom version`, then run `muvloom auth status --json`. If unauthenticated, run `muvloom auth login --start`, direct the user to the returned verification URI, and wait for explicit confirmation before `muvloom auth login --resume`. Login and capability checks create no image, task, charge, or sample.

Do not request, print, or store access tokens in the Skill. The CLI stores and refreshes credentials securely.
