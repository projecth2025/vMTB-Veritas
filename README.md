# vMTB Veritas — Virtual Molecular Tumor Board Platform

**vMTB Veritas (v2)** is an advanced, secure clinical platform designed for oncologists, pathologists, genomic specialists, and multidisciplinary care teams to collaborate on complex cancer cases, conduct Virtual Molecular Tumor Boards (MTBs), review patient genomic profiles, and streamline precision oncology workflows. The website is live on https://vmtb.3billionpairs.com/

---

## 🌟 Key Features

### 🛡️ Authentication & Security
- **Multi-Factor & Flexible Authentication**:
  - **Continue with Google** (OAuth 2.0)
  - **Phone Number + Password**
  - **Phone Number + WhatsApp OTP** (powered by Gupshup & Supabase Edge Functions)
- **Account & Duplicate Prevention**:
  - Real-time check to prevent duplicate phone registration during signup.
  - Automatic redirection to signup when an unregistered user attempts login.
- **WhatsApp OTP Password Reset**:
  - Seamless, linkless password reset flow verified directly through WhatsApp OTP.
- **Real-Time Password Strength Validation**:
  - Live interactive checklist enforcing security criteria:
    - 8+ characters long
    - At least 1 number
    - At least 1 uppercase letter
- **Route Guarding & Session Persistence**:
  - Protected routes (`/my-cases`, `/mtbs`, `/cases/new/...`, `/case/:id`, etc.) automatically redirect unauthenticated users to `/login`.
  - Reliable session cleanup on logout preventing unauthorized back-navigation.

---

### 📋 Patient Case Management
- **Multi-Step Case Creation Workflow**:
  - Step 1: Patient demographics, clinical diagnosis, cancer stage, and medical history.
  - Step 2: Genomic profiling uploads, biomarker reporting, and diagnostic file attachments.
  - Step 3: Comprehensive case review before submission.
- **Document & Media Handling**:
  - Native support for PDF reports, images, and automatic HEIC image conversion (`heic2any`).
- **Interactive Case Viewer**:
  - View full diagnostic summaries, genomic insights, attached files, and discussion logs.

---

### 👥 Virtual Molecular Tumor Board (MTB) Meetings
- **MTB Dashboards & Scheduling**:
  - View scheduled MTB sessions, participant lists, and assigned cases.
- **Multidisciplinary Collaboration**:
  - Centralized discussion board per case with markdown rendering for clinical notes.

---

### 📱 Responsive & Modern UI/UX
- **Tailwind CSS & Modern Typography**: Clean, accessible clinical design system with tailored healthcare aesthetics.
- **Mobile Navigation**: Dedicated drawer navigation optimized for touch devices.

---

## 🚀 Tech Stack

- **Frontend Core**: [React 18](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vitejs.dev/)
- **Styling & UI**: [Tailwind CSS](https://tailwindcss.com/), [Lucide React Icons](https://lucide.dev/), [React Hot Toast](https://react-hot-toast.com/)
- **Routing**: [React Router DOM v7](https://reactrouter.com/)
- **Backend & Auth**: [Supabase](https://supabase.com/) (Auth, PostgreSQL Database, Storage, Edge Functions)
- **Integrations**: Gupshup WhatsApp API (via Supabase Edge Function `verify_whatsapp_otp`)
- **Document Processing**: `pdfjs-dist`, `heic2any`, `marked`, `dompurify`, `turndown`

---

## 📂 Project Structure

```text
VMTB-Veritas/
├── src/
│   ├── components/       # Reusable UI components (Layout, PasswordInput, PasswordStrength, MobileNav, Modal, etc.)
│   ├── context/          # React Context providers (AuthContext, CasesContext, CaseCreationContext)
│   ├── hooks/            # Custom hooks (useMobile, etc.)
│   ├── pages/            # Main application views (Login, Signup, ForgotPassword, ResetPassword, MyCases, MTBs, etc.)
│   ├── services/         # API & Integration services (whatsappOtp.ts)
│   ├── Supabase/         # Supabase client configuration
│   ├── utils/            # Helper utilities (toast formatting, phone helpers)
│   ├── App.tsx           # Route setup and ProtectedRoute guards
│   └── main.tsx          # Application entry point
├── supabase/
│   └── functions/        # Deno-based Supabase Edge Functions (verify_whatsapp_otp)
├── public/               # Static assets & icons
├── package.json          # Dependencies and script definitions
├── tsconfig.json         # TypeScript configuration
└── vite.config.ts        # Vite configuration
```

---

## 🛠️ Getting Started

### Prerequisites
- **Node.js**: `v18.0.0` or higher
- **npm**: `v9.0.0` or higher

### Environment Setup
Create a `.env` file in the project root with your Supabase project credentials:

```env
VITE_SUPABASE_URL=https://your-supabase-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

### Installation & Running Locally

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-org/VMTB-Veritas.git
   cd VMTB-Veritas
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the local development server**:
   ```bash
   npm run dev
   ```
   The application will be available at `http://localhost:5173`.

4. **Run TypeScript Type Verification**:
   ```bash
   npm run typecheck
   ```

5. **Build for Production**:
   ```bash
   npm run build
   ```

---

## 🔒 Security & Privacy

- All user data and clinical files are transmitted over HTTPS and authenticated using Supabase JWT tokens.
- Protected routes strictly validate user session tokens before granting access to patient records or MTB meetings.
- Passwords are validated client-side and attached directly to Supabase Auth user accounts with server-side administrative verification.

---

## 📄 License

Private & Confidential — vMTB Veritas Platform.
