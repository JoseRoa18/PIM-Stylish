import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Package,
  Image as ImageIcon,
  Share2,
  FileSpreadsheet,
  Activity,
  BarChart3,
  Settings,
  HelpCircle,
  Bell,
  Plus,
} from 'lucide-react';
import { cn } from '@/lib/cn';

const NAV_ITEMS = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/catalog', icon: Package, label: 'Catalog' },
  { to: '/assets', icon: ImageIcon, label: 'Assets' },
  { to: '/syndication', icon: Share2, label: 'Syndication' },
  { to: '/templates', icon: FileSpreadsheet, label: 'Templates' },
  { to: '/listing-health', icon: Activity, label: 'Listing Health' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 h-full flex flex-col w-64 bg-surface-container-low border-r border-outline-variant z-40">
      {/* Brand */}
      <div className="p-6">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-lg bg-primary text-on-primary font-bold flex items-center justify-center text-lg">
            S
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-title-lg text-primary">Stylish PIM</span>
            <span className="text-label-md text-on-surface-variant">Enterprise Edition</span>
          </div>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg transition-colors',
                isActive
                  ? 'bg-secondary-container text-on-secondary-container font-semibold'
                  : 'text-secondary hover:bg-surface-container-high'
              )
            }
          >
            <item.icon className="w-5 h-5" />
            <span className="text-label-md">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Footer: CTA + utility links */}
      <div className="p-4 flex flex-col gap-1">
        <button className="w-full bg-primary text-on-primary py-2 px-4 rounded-lg font-semibold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity mb-2 text-label-md">
          <Plus className="w-4 h-4" />
          Create Product
        </button>
        <button className="flex items-center gap-2 px-4 py-2 text-secondary hover:bg-surface-container-high rounded-lg transition-colors text-label-md">
          <HelpCircle className="w-5 h-5" />
          <span>Support</span>
        </button>
        <button className="flex items-center gap-2 px-4 py-2 text-secondary hover:bg-surface-container-high rounded-lg transition-colors text-label-md relative">
          <Bell className="w-5 h-5" />
          <span>Notifications</span>
          <span className="absolute right-4 w-2 h-2 bg-error rounded-full" />
        </button>
      </div>
    </aside>
  );
}