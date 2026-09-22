/** Type augmentation for Electron APIs missing from the bundled electron.d.ts.
 * `app.setDesktopName` (Linux/Wayland only) matches the app to its
 * `*.desktop` file's `StartupWMClass`. It exists at runtime but isn't
 * declared in the `electron` package's own type definitions. */
import 'electron'

declare global {
  namespace Electron {
    interface App {
      setDesktopName(desktopName: string): void
    }
  }
}
