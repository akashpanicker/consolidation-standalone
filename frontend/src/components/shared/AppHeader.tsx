import { useState, useRef, useEffect } from "react";
import { Globe, Check, LogOut, Settings, Sun, Moon } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { useAuth } from "@/hooks/useAuth";

interface BreadcrumbItem {
  label: string;
  path?: string;
  onClick?: () => void;
}

interface HeaderProps {
  title?: string;
  breadcrumb?: string | BreadcrumbItem[];
  showUser?: boolean;
  onGovernance?: () => void;
  centerContent?: React.ReactNode;
}

export function AppHeader({
  title = "Consolidation (Standalone)",
  breadcrumb,
  showUser = true,
  onGovernance,
  centerContent,
}: HeaderProps) {
  const { darkMode, toggleDarkMode } = useAppStore();
  const authUser = useAuth();

  const language = 'en'; // Default
  const [showLangDropdown, setShowLangDropdown] = useState(false);
  const [showUserDropdown, setShowUserDropdown] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const userDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowLangDropdown(false);
      }
      if (userDropdownRef.current && !userDropdownRef.current.contains(event.target as Node)) {
        setShowUserDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const languages = [
    { code: "en", badge: "EN", label: "English" },
    { code: "es", badge: "ES", label: "Español" },
  ];

  return (
    <header className="flex items-start px-4 pr-6 relative shrink-0 bg-card border-b border-border h-[52px] z-50">
      {/* Left content */}
      <div className="flex-1 flex gap-3 h-full items-center min-h-px min-w-px">
        {/* Logo */}
        <div className="flex h-full items-center justify-center relative shrink-0 py-2">
          <img
            src={darkMode ? "/hp-logo-dark.svg" : "/hp-logo.svg"}
            alt="H&P Logo"
            className="block h-full w-auto object-contain shrink-0"
          />
        </div>

        {/* Title & Breadcrumb */}
        <div className="flex flex-col h-full items-start justify-center pb-1 relative shrink-0">
          <div className="flex gap-2 items-center -mb-1 relative shrink-0">
            <h1 className="flex flex-col font-semibold justify-end leading-none relative shrink-0 text-foreground text-base">
              {title}
            </h1>
          </div>

          {breadcrumb && (
            <div className="flex items-start -mb-1 relative shrink-0">
              <p className="font-normal leading-normal text-sm whitespace-nowrap text-muted-foreground mt-1 gap-2 flex items-center">
                {typeof breadcrumb === "string" ? breadcrumb : (
                  Array.isArray(breadcrumb) && breadcrumb.map((item, idx) => (
                    <span key={idx} className="inline-flex items-center">
                      <span
                        className={`transition-colors ${(item.path || item.onClick) ? 'cursor-pointer hover:text-foreground hover:underline' : 'cursor-default'}`}
                        onClick={() => {
                          if (item.onClick) item.onClick();
                          else if (item.path) window.location.href = item.path;
                        }}
                      >
                        {item.label}
                      </span>
                      {idx < breadcrumb.length - 1 && (
                        <span className="ml-2 text-muted-foreground opacity-50">/</span>
                      )}
                    </span>
                  ))
                )}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Middle content */}
      <div className="flex-1 flex flex-col h-full items-center justify-center min-h-px min-w-px">
        {centerContent}
      </div>

      {/* Right content */}
      <div className="flex-1 flex gap-6 h-full items-center justify-end min-h-px min-w-px">
        <div className="flex gap-2 items-center shrink-0">

          {/* Governance Settings Button */}
          {onGovernance && (
            <button
              type="button"
              onClick={onGovernance}
              className="flex items-center justify-center w-8 h-8 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="Review Governance"
            >
              <Settings size={18} />
            </button>
          )}

          {/* Theme Toggle Inline */}
          <button
            type="button"
            onClick={toggleDarkMode}
            className="flex items-center justify-center w-8 h-8 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="Toggle theme"
          >
            {darkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          {/* Language Switcher */}
          <div ref={dropdownRef} className="relative flex items-center shrink-0">
            <button
              type="button"
              onClick={() => setShowLangDropdown(!showLangDropdown)}
              className={`flex flex-col items-center justify-center w-8 h-8 rounded-md transition-colors ${showLangDropdown ? 'bg-accent text-primary' : 'hover:bg-accent text-muted-foreground hover:text-foreground'}`}
              title="Switch Language"
            >
              <Globe size={18} />
              <span className="text-[9px] font-semibold leading-none mt-0.5">
                {language.toUpperCase()}
              </span>
            </button>

            {/* Dropdown */}
            {showLangDropdown && (
              <div className="absolute right-0 top-full mt-1.5 w-40 bg-card border border-border rounded-lg shadow-md py-1.5 z-50 flex flex-col">
                <div className="px-3 py-2 border-b border-border mb-1">
                  <span className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
                    Language
                  </span>
                </div>

                {languages.map((lang) => {
                  const isActive = language === lang.code;
                  return (
                    <button
                      key={lang.code}
                      type="button"
                      onClick={() => setShowLangDropdown(false)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent ${isActive ? 'bg-accent' : 'bg-transparent'}`}
                      style={{ borderLeft: isActive ? "3px solid var(--primary)" : "3px solid transparent" }}
                    >
                      <span className="bg-muted border border-border rounded px-1.5 py-0.5 text-foreground text-[11px] font-semibold">
                        {lang.badge}
                      </span>
                      <span className={`flex-1 text-[13px] ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {lang.label}
                      </span>
                      {isActive && <Check size={14} className="text-green-500 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* User */}
        {showUser && authUser && (
          <div ref={userDropdownRef} className="relative flex gap-2 items-center shrink-0">
            <div
              className={`flex gap-2 items-center cursor-pointer p-1 pr-2 rounded-md transition-colors ${showUserDropdown ? 'bg-accent' : 'hover:bg-accent'}`}
              onClick={() => setShowUserDropdown(!showUserDropdown)}
            >
              {/* Avatar */}
              <div className="relative shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center overflow-hidden border border-border">
                <span className="text-muted-foreground text-xs font-semibold">
                  {authUser.name?.charAt(0) || "U"}
                </span>
              </div>

              {/* Name & Role */}
              <div className="flex flex-col gap-0.5 items-start">
                <p className="text-sm font-semibold leading-none text-foreground">
                  {authUser.name}
                </p>
                <p className="text-[12px] font-normal leading-none text-muted-foreground">
                  User
                </p>
              </div>
            </div>

            {/* User Dropdown */}
            {showUserDropdown && (
              <div className="absolute right-0 top-full mt-1.5 w-40 bg-card border border-border rounded-lg shadow-md py-1.5 z-50 flex flex-col">
                <button
                  type="button"
                  onClick={() => setShowUserDropdown(false)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors"
                >
                  <LogOut size={16} className="text-muted-foreground shrink-0" />
                  <span className="text-foreground text-[13px]">
                    Logout
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
