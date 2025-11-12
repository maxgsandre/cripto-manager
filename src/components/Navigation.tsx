"use client";
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

interface User {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

interface NavigationProps {
  user?: User;
  onSignOut?: () => void;
}

export function Navigation({ user, onSignOut }: NavigationProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

  const navItems = [
    { href: '/dashboard', label: 'Dashboard', icon: '📊' },
    { href: '/trades', label: 'Trades', icon: '🔥' },
    { href: '/cashflow', label: 'Depósitos/Saques', icon: '💸' },
    { href: '/accounts', label: 'Accounts', icon: '👤' },
  ];

  return (
    <header className="border-b border-white/10 bg-black/20 backdrop-blur-xl relative z-[100]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
        <div className="flex items-center justify-between gap-3">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <Image
              src="/logo-symbol.png"
              alt="Cripto Manager"
              width={40}
              height={40}
              className="h-10 w-10"
            />
            <div>
              <h1 className="text-white font-semibold">Cripto Manager</h1>
              <p className="text-xs text-slate-400">Trading Dashboard</p>
            </div>
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-2 sm:gap-4">
            {/* Hamburger Button - Mobile & Desktop */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="text-white p-2"
              aria-label="Toggle menu"
            >
              <span className="text-2xl">{mobileMenuOpen ? '✕' : '☰'}</span>
            </button>


            {/* User Avatar */}
            {user && (
              <div className="relative z-[100]">
                <button
                  onClick={() => setProfileMenuOpen(!profileMenuOpen)}
                  className="flex items-center gap-2"
                >
                  {user.image ? (
                    <Image
                      src={user.image}
                      alt="User"
                      width={32}
                      height={32}
                      className="w-8 h-8 rounded-full hover:ring-2 ring-blue-500 transition-all"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center hover:ring-2 ring-blue-500 transition-all">
                      <span className="text-white text-sm font-semibold">
                        {user.name?.charAt(0) || user.email?.charAt(0) || 'U'}
                      </span>
                    </div>
                  )}
                </button>

                {/* Profile Menu Dropdown */}
                {profileMenuOpen && (
                  <div className="absolute right-0 top-14 w-64 bg-slate-900 border border-white/10 rounded-xl shadow-xl z-[100]">
                    <div className="p-4 border-b border-white/10">
                      <p className="text-white font-semibold">{user.name || 'Usuário'}</p>
                      <p className="text-slate-400 text-sm">{user.email}</p>
                    </div>
                    <div className="p-2">
                      <button 
                        onClick={() => {
                          router.push('/settings');
                          setProfileMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-3 px-3 py-2 text-slate-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                        <span className="text-lg">⚙️</span>
                        <span>Configurações</span>
                      </button>
                      <button 
                        onClick={() => {
                          router.push('/settings/security');
                          setProfileMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-3 px-3 py-2 text-slate-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                        <span className="text-lg">🔒</span>
                        <span>Alterar Senha</span>
                      </button>
                      <button 
                        onClick={() => {
                          router.push('/stats');
                          setProfileMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-3 px-3 py-2 text-slate-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                        <span className="text-lg">📊</span>
                        <span>Estatísticas</span>
                      </button>
                      <div className="border-t border-white/10 my-2" />
                      <button 
                        onClick={() => {
                          if (onSignOut) onSignOut();
                          setProfileMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-3 px-3 py-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors"
                      >
                        <span className="text-lg">🚪</span>
                        <span>Sair</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Overlay para fechar menus ao clicar fora */}
      {(mobileMenuOpen || profileMenuOpen) && (
        <div 
          className="fixed inset-0 z-[90]" 
          onClick={() => {
            setMobileMenuOpen(false);
            setProfileMenuOpen(false);
          }}
        />
      )}

      {/* Mobile & Desktop Menu */}
      {mobileMenuOpen && (
        <div className="border-t border-white/10 bg-black/20 backdrop-blur-xl relative z-[100]">
          <div className="max-w-7xl mx-auto px-4 py-3">
            <nav className="flex flex-col gap-2">
              {navItems.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`flex items-center space-x-2 px-4 py-3 rounded-lg font-medium transition-colors ${
                      isActive
                        ? 'bg-white/10 text-white'
                        : 'text-slate-300 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span className="text-xl">{item.icon}</span>
                    <span>{item.label}</span>
                  </Link>
                );
              })}
              {user && (
                <div className="border-t border-white/10 pt-3 mt-2">
                  <button
                    onClick={() => {
                      if (onSignOut) onSignOut();
                      setMobileMenuOpen(false);
                    }}
                    className="flex items-center space-x-2 px-4 py-3 rounded-lg font-medium text-slate-300 hover:text-white hover:bg-white/5 w-full"
                  >
                    <span className="text-xl">🚪</span>
                    <span>Sair</span>
                  </button>
                </div>
              )}
            </nav>
          </div>
        </div>
      )}
    </header>
  );
}
