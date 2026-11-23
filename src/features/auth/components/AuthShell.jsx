import ThemeToggle from '@/components/ui/ThemeToggle';

// The page a person sees before they are signed in: the brand, one card, the
// footer. Shared by the sign-in page and the page a reset link opens, so the
// two are the same place.
export default function AuthShell({ children }) {
  return (
    <div className="relative min-h-screen bg-background flex items-center justify-center p-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <main className="w-full max-w-md">
        {/* Brand header */}
        <div className="mb-8 text-center">
          {/* Icon pair toggled via the app's .dark class — the `dark:` variant
              tracks the OS scheme here, not the in-app theme toggle. */}
          <img src="/brand/icon.svg" alt="" className="w-16 h-16 mx-auto mb-3 [.dark_&]:hidden" />
          <img src="/brand/icon-dark.svg" alt="" className="w-16 h-16 mx-auto mb-3 hidden [.dark_&]:block" />
          <h1 className="text-headline-md text-on-surface">Stylish PIM</h1>
          <p className="text-on-surface-variant text-body-sm mt-1">
            Centralized Product Management
          </p>
        </div>

        <div className="bg-surface rounded-2xl shadow-sm border border-outline-variant p-8">
          {children}
        </div>

        {/* Footer */}
        <p className="text-center text-label-md text-on-surface-variant mt-6">
          Stylish International Inc. · Internal product management system
        </p>
      </main>
    </div>
  );
}
