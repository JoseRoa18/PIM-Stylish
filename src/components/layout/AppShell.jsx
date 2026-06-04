import Sidebar from './Sidebar';
import Topbar from './Topbar';

export default function AppShell({ children }) {
  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <div className="ml-64 h-screen flex flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-[1400px] mx-auto px-8 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}