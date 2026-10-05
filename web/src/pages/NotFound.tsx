import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <div className="empty-state">
      <h1>Page not found</h1>
      <Link to="/" className="button secondary">
        Back to catalogs
      </Link>
    </div>
  );
}
