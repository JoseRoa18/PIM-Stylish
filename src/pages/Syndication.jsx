import WixConnectorCard from '@/features/syndication/components/WixConnectorCard';

export default function Syndication() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-display-lg text-on-surface">Syndication</h1>
        <p className="text-body-md text-on-surface-variant mt-1">
          Connect Stylish PIM to external sales channels and keep product data in sync.
        </p>
      </header>

      <WixConnectorCard />
    </div>
  );
}
