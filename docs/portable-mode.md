# Portable Mode

Portable mode (`encrypted-portable` storage) keeps the instance configuration in server memory only. Nothing is written to disk. The persistent copy of the configuration is the encrypted backup file the admin downloads.

Portable mode is available with admin-password sign-in. It suits **temporary or ephemeral servers** where no data should remain on disk. For most setups, `persistent` or `encrypted-persistent` is simpler.

## What the Encrypted Config Contains

- **Vault public key package** — group key, per-party public shares, threshold
- **Address book**
- **Hosting** — domain, port, path, HTTPS settings
- **Chain API** — custom Esplora URL, if set
- **Sign-in settings** — the admin password hash
- **Network** — mainnet, testnet4 or signet

It contains **no key shares**. The share files held by the parties control the vault. A lost configuration loses the address book and settings, not funds: an admin can reconnect a fresh instance to the vault with **Use existing share file** in the DKG step.

## Initial Setup Flow

1. **Install wizard:** choose the network, admin-password sign-in, and **Encrypted Portable** storage.
2. **DKG ceremony:** run the key generation with all parties. Each party downloads its share file.
3. **Download the encrypted config.** A banner appears at the top of every page once the vault exists. Click it, enter a password, and save the `.enc` file.

The banner stays visible until the config is downloaded.

## Returning After a Restart

When the server restarts, the in-memory config is gone and the instance shows the install wizard.

1. Visit the instance URL.
2. On the first wizard step, click **Restore from Backup**.
3. Select the `.enc` file and enter its password.
4. The config loads into memory and the instance is operational.

Download a fresh backup after changes you want to keep (address book edits, hosting changes).

## How Co-signers Experience It

Co-signers need no password. They open the session link the initiator shares and load their own share file. They can only connect while the server is running with the config loaded; before the admin restores, they see the install wizard.

## Server Restart Behavior

When the server process restarts (crash, redeploy, host reboot):

- The in-memory config is cleared.
- `/api/status` returns `{ state: 'fresh' }`.
- Everyone visiting the URL sees the install wizard until the admin restores.

There is no automatic restoration.

## Trade-offs

| Pro | Con |
|-----|-----|
| Nothing on the server filesystem | Admin must restore after every restart |
| Server can be ephemeral | Admin must re-export after changes |
| No server-side encryption secrets | Co-signers depend on the admin restoring first |

## Recommendations

- Keep the encrypted config in more than one place.
- Use a strong password for the backup.
- Test restoration before relying on portable mode.
- Consider `encrypted-persistent` instead: same encryption, but the server keeps the encrypted file so a restart only needs the password.
