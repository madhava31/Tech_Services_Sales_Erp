import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { canRecordQuotations, canWriteCrm, isAdminRole, isManagingRole } from './lib/roles';
import Layout from './components/Layout';
import SignIn from './pages/SignIn';
import Today from './pages/Today';
import Visits from './pages/visits/Visits';
import NewVisit from './pages/visits/NewVisit';
import NewOpportunity from './pages/pipeline/NewOpportunity';
import Opportunities from './pages/pipeline/Opportunities';
import VisitDetail, { LocalVisitDetail } from './pages/visits/VisitDetail';
import Companies from './pages/companies/Companies';
import CompanyDetail from './pages/companies/CompanyDetail';
import Tasks from './pages/tasks/Tasks';
import Pipeline from './pages/pipeline/Pipeline';
import DealDetail from './pages/pipeline/DealDetail';
import QuotationQueue from './pages/pipeline/QuotationQueue';
import Performance from './pages/Performance';
import More from './pages/More';
import Team from './pages/team/Team';
import Handover from './pages/team/Handover';
import AdminHome from './pages/admin/AdminHome';
import Users from './pages/admin/Users';
import Salespeople from './pages/admin/Salespeople';
import AuditLog from './pages/admin/AuditLog';
import Catalogue from './pages/admin/Catalogue';
import Import from './pages/admin/Import';
import ErpSync from './pages/admin/ErpSync';
import Analysis from './pages/Analysis';
import WeeklyReports from './pages/reports/WeeklyReports';
import Tenders from './pages/tenders/Tenders';
import Renewals from './pages/renewals/Renewals';
import Notifications from './pages/Notifications';
import SyncStatus from './pages/SyncStatus';
import Approvals from './pages/companies/Approvals';
import Products, { ProductDetail } from './pages/products/Products';

export default function App() {
  const { user, needsSetup, loading } = useAuth();

  if (loading) return <p className="p-6 text-sm text-ink-faint">Loading…</p>;
  if (needsSetup) return <SignIn mode="setup" />;
  if (!user) return <SignIn mode="login" />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Today />} />
        <Route path="visits" element={<Visits />} />
        {canWriteCrm(user.role) && <Route path="visits/new" element={<NewVisit />} />}
        <Route path="opportunities" element={<Opportunities />} />
        {canWriteCrm(user.role) && <Route path="opportunities/new" element={<NewOpportunity />} />}
        <Route path="visits/local/:uuid" element={<LocalVisitDetail />} />
        <Route path="visits/:id" element={<VisitDetail />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="sync" element={<SyncStatus />} />
        <Route path="companies" element={<Companies />} />
        <Route path="companies/:id" element={<CompanyDetail />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="pipeline" element={<Pipeline />} />
        <Route path="pipeline/:id" element={<DealDetail />} />
        <Route path="products" element={<Products />} />
        <Route path="products/:id" element={<ProductDetail />} />
        <Route path="performance" element={<Performance />} />
        <Route path="analysis" element={<Analysis />} />
        <Route path="tenders" element={<Tenders />} />
        <Route path="renewals" element={<Renewals />} />
        {isManagingRole(user.role) && <Route path="approvals" element={<Approvals />} />}
        <Route path="more" element={<More />} />
        {user.role !== 'salesperson' && <Route path="team" element={<Team />} />}
        {user.role !== 'salesperson' && <Route path="reports" element={<WeeklyReports />} />}
        {isManagingRole(user.role) && <Route path="team/handover" element={<Handover />} />}
        {canRecordQuotations(user.role) && <Route path="quotation-requests" element={<QuotationQueue />} />}
        {isAdminRole(user.role) && (
          <>
            <Route path="admin" element={<AdminHome />} />
            <Route path="admin/users" element={<Users />} />
            <Route path="admin/salespeople" element={<Salespeople />} />
            <Route path="admin/audit" element={<AuditLog />} />
            <Route path="admin/catalogue" element={<Catalogue />} />
            <Route path="admin/import" element={<Import />} />
            <Route path="admin/erp" element={<ErpSync />} />
          </>
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
