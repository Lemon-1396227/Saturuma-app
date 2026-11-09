        /* ========================================================
           0. CONFIGURATION & GOOGLE APPS SCRIPT API BRIDGE
           (Memungkinkan Frontend GitHub Pages terhubung ke Google Apps Script)
           ======================================================== */
        window.APP_CONFIG = window.APP_CONFIG || {
            // URL Web App Deployment Google Apps Script (bisa diisi di sini atau via menu Pengaturan)
            GAS_API_URL: ""
        };

        /* Safe Storage Memory Fallback */
        const safeStorage = {
            _store: {},
            getItem: function(key) {
                try { return localStorage.getItem(key); } catch(e) { return this._store[key] || null; }
            },
            setItem: function(key, val) {
                try { localStorage.setItem(key, val); } catch(e) { this._store[key] = String(val); }
            },
            removeItem: function(key) {
                try { localStorage.removeItem(key); } catch(e) { delete this._store[key]; }
            }
        };

        function sanitizeGasUrl(url) {
            if (!url || typeof url !== 'string') return "";
            let clean = url.trim().replace(/^["']|["']$/g, '');
            if (!clean) return "";

            // Deteksi jika user salah menempelkan link Google Apps Script Project Editor
            if (clean.includes('script.google.com') && (clean.includes('/edit') || clean.includes('/home/projects/'))) {
                throw new Error("Tautan ini adalah link editor skrip, bukan Web App URL. Silakan klik Deploy > New deployment > Web app > salin 'Web app URL' (akhiran /exec).");
            }

            // Jika berakhiran /dev, otomatis ubah ke /exec
            if (clean.includes('/macros/s/') && clean.endsWith('/dev')) {
                clean = clean.replace(/\/dev$/, '/exec');
            }

            // Bersihkan parameter query (misal ?usp=sharing atau ?authuser=0)
            if (clean.includes('/macros/s/') && clean.includes('?')) {
                const parts = clean.split('?');
                if (parts[0].endsWith('/exec')) {
                    clean = parts[0];
                }
            }

            return clean;
        }

        function getActiveGasApiUrl() {
            const fromConfig = (window.APP_CONFIG && window.APP_CONFIG.GAS_API_URL) ? window.APP_CONFIG.GAS_API_URL.trim() : "";
            const fromStorage = safeStorage ? (safeStorage.getItem('saturuma_gas_api_url') || "").trim() : "";
            const raw = fromConfig || fromStorage;
            try {
                return sanitizeGasUrl(raw);
            } catch(e) {
                return raw;
            }
        }

        // Inisialisasi Polyfill jika dijalankan di luar ekosistem Apps Script iframe (misal: GitHub Pages)
        (function initGoogleScriptBridge() {
            if (typeof window.google !== 'undefined' && window.google.script && window.google.script.run) {
                // Berjalan langsung di dalam Google Apps Script Web App iframe
                return;
            }

            window.google = window.google || {};
            window.google.script = window.google.script || {};

            function executeBackendApi(action, args, onSuccess, onFailure) {
                const apiUrl = getActiveGasApiUrl();
                if (!apiUrl) {
                    if (onFailure) onFailure(new Error("URL Backend Google Apps Script belum dikonfigurasi."));
                    return;
                }

                // Ambil token sesi & user ID aktif untuk otentikasi dan isolasi data pribadi
                let currentSessionToken = (typeof state !== 'undefined' && state.sessionToken) || "";
                let currentUserId = (typeof state !== 'undefined' && state.currentUser && state.currentUser.userId) || "";
                if (!currentSessionToken) {
                    try {
                        const raw = safeStorage.getItem('saturuma_session') || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('saturuma_session_temp') : null);
                        if (raw) {
                            const parsed = JSON.parse(raw);
                            currentSessionToken = parsed.token || "";
                            if (!currentUserId && parsed.user) currentUserId = parsed.user.userId || "";
                        }
                    } catch(e) {}
                }

                // Timeout terukur berdasarkan jenis aksi backend
                let timeoutMs = 35000;
                if (action === 'extractReceiptWithAI' || action === 'saveBase64File' || action === 'processForm') {
                    timeoutMs = 90000;
                } else if (action === 'verifyUserLogin' || action === 'validateSession' || action === 'ping') {
                    timeoutMs = 18000;
                }

                let controller = null;
                let signal = undefined;
                let timer = null;
                if (typeof AbortController !== 'undefined') {
                    controller = new AbortController();
                    signal = controller.signal;
                    timer = setTimeout(() => {
                        try { controller.abort(); } catch(e) {}
                    }, timeoutMs);
                }

                fetch(apiUrl, {
                    method: 'POST',
                    mode: 'cors',
                    headers: {
                        'Content-Type': 'text/plain;charset=utf-8'
                    },
                    body: JSON.stringify({
                        action: action,
                        args: args,
                        sessionToken: currentSessionToken,
                        userId: currentUserId,
                        timestamp: Date.now()
                    }),
                    redirect: 'follow',
                    signal: signal
                })
                .then(async (res) => {
                    if (timer) clearTimeout(timer);
                    if (!res.ok) {
                        throw new Error("HTTP " + res.status + " (" + res.statusText + ")");
                    }
                    const text = await res.text();
                    if (!text || !text.trim()) {
                        throw new Error("Backend tidak mengembalikan respon data.");
                    }
                    const trimmed = text.trim();
                    if (trimmed.startsWith('<') || trimmed.includes('accounts.google.com') || trimmed.includes('ServiceLogin')) {
                        throw new Error("Akses ditolak atau otorisasi Google diperlukan. Pastikan Web App disetel 'Who has access: Anyone'.");
                    }
                    try {
                        return JSON.parse(text);
                    } catch(jsonErr) {
                        throw new Error("Respon backend bukan JSON valid: " + text.slice(0, 80));
                    }
                })
                .then((json) => {
                    if (onSuccess) onSuccess(json);
                })
                .catch((err) => {
                    if (timer) clearTimeout(timer);
                    let errMsg = err.message || String(err);
                    if (err.name === 'AbortError') {
                        errMsg = "Koneksi backend timeout (" + Math.round(timeoutMs / 1000) + " detik). Server Google sedang lambat.";
                    }
                    console.error("GAS Bridge Error [" + action + "]:", errMsg);
                    if (onFailure) onFailure(new Error(errMsg));
                });
            }

            function createRunner() {
                let successCb = null;
                let failureCb = null;
                let userObj = null;
                let proxyInstance = null;

                const runner = {
                    withSuccessHandler: function(fn) {
                        successCb = fn;
                        return proxyInstance;
                    },
                    withFailureHandler: function(fn) {
                        failureCb = fn;
                        return proxyInstance;
                    },
                    withUserObject: function(obj) {
                        userObj = obj;
                        return proxyInstance;
                    }
                };

                proxyInstance = new Proxy(runner, {
                    get: function(target, prop) {
                        if (prop in target) return target[prop];
                        return function(...args) {
                            try {
                                executeBackendApi(prop, args, successCb, failureCb);
                            } catch (err) {
                                console.error("GAS Bridge API Execution Error [" + String(prop) + "]:", err);
                                if (failureCb) failureCb(err);
                            }
                        };
                    }
                });

                return proxyInstance;
            }

            // Pasang proxy ke google.script.run
            Object.defineProperty(window.google.script, 'run', {
                get: function() {
                    const url = getActiveGasApiUrl();
                    if (!url) return undefined; // Biarkan fallback ke mock jika belum ada URL
                    return createRunner();
                },
                configurable: true
            });
        })();

        /* STATE GLOBAL SATURUMA */
        const state = {
            appName: "Saturuma",
            currentView: "dashboard",
            currentSubInputMode: "manual",
            activeMasterCategoryId: "all", // "all" atau ID seperti "bayi", "dapur", dsb.
            masterCategories: [
                {
                    id: "bayi",
                    name: "Kebutuhan Bayi",
                    sheetName: "DB_Bayi",
                    color: "#F47174",
                    icon: "fa-baby-carriage",
                    subCategories: ["Popok", "Susu & Makanan", "Pakaian", "Kesehatan & Mandi", "Gear & Perlengkapan", "Mainan & Buku", "Lainnya"]
                },
                {
                    id: "dapur",
                    name: "Belanja Dapur & Groceries",
                    sheetName: "DB_Dapur",
                    color: "#10B981",
                    icon: "fa-basket-shopping",
                    subCategories: ["Sembako & Bumbu", "Sayur & Buah", "Daging & Ikan", "Makanan Instan & Camilan", "Minuman", "Alat Dapur", "Perlengkapan Cuci"]
                },
                {
                    id: "tagihan",
                    name: "Tagihan & Rutinitas Rumah",
                    sheetName: "DB_Tagihan",
                    color: "#3B82F6",
                    icon: "fa-file-invoice-dollar",
                    subCategories: ["Listrik PLN", "Air PDAM", "Internet & WiFi", "Gas Elpiji", "Iuran RT/RW & Keamanan", "Sampah & Kebersihan", "Cicilan & Sewa"]
                },
                {
                    id: "tabungan",
                    name: "Tabungan & Investasi",
                    sheetName: "DB_Tabungan",
                    color: "#A855F7",
                    icon: "fa-piggy-bank",
                    subCategories: ["Dana Darurat", "Tabungan Pendidikan", "Emas & Logam Mulia", "Reksadana & Saham", "Asuransi", "Tabungan Khusus"]
                },
                {
                    id: "transport",
                    name: "Transportasi & Kendaraan",
                    sheetName: "DB_Transport",
                    color: "#F59E0B",
                    icon: "fa-car",
                    subCategories: ["Bensin & BBM", "Tol & Parkir", "Servis & Oli", "Pajak & STNK", "Angkutan Umum / Ojol", "Cuci Kendaraan", "Sparepart"]
                }
            ],
            entries: [],
            receipts: [],
            stats: {
                totalSpent: 0,
                totalItems: 0,
                thisMonthSpent: 0,
                todaySpent: 0,
                dailyAverage: 0,
                categoryBreakdown: {},
                subCategoryBreakdown: {},
                monthlyBreakdown: {},
                monthlyBudget: 10000000
            },
            metadata: null,
            chartInstance: null,
            trendChartInstance: null,
            monthlyCompareChartInstance: null,
            currentChartType: "doughnut",
            dashboardSubMenu: "overview",
            dashboardPeriod: "month",
            dashboardMonthDate: new Date(),
            dashboardSubCategory: "all",
            dashboardMerchant: "all",
            dashboardStartDate: "",
            dashboardEndDate: "",
            reminders: [],
            reminderTab: "active",
            reminderSubMenu: "reminders", // "reminders" atau "catalog"
            reminderModuleFilter: "all",
            reminderCalendarDate: null,
            reminderSelectedDate: null,
            holidaysCache: {},
            stockItems: [],
            itemCatalogSearch: "",
            itemCatalogCategoryFilter: "all",
            pendingDeleteReceiptId: null,
            formItemIndexCounter: 0,
            categoryBudgets: {},
            currentUser: null,
            sessionToken: null
        };

        /* ========================================================
           0. SISTEM OTENTIKASI & KEAMANAN PENGGUNA (DATABASE DB_Users)
           - Demo Akun: admin / admin 123
           - Registrasi Pengguna Baru (Dedicated Google Sheets / Multi-User)
           - Proteksi Brute Force, Session Tokens, SHA-256 Salted Hashing
           ======================================================== */
        function switchAuthTab(tab) {
            const contentLogin = document.getElementById('loginTabContent');
            const contentRegister = document.getElementById('registerTabContent');
            const tabLoginBtn = document.getElementById('authTabLogin');
            const tabRegisterBtn = document.getElementById('authTabRegister');
            const errBox = document.getElementById('loginErrorBox');
            if (errBox) errBox.classList.add('hidden');

            const isRegister = (tab === 'register');

            if (contentLogin) contentLogin.classList.toggle('hidden', isRegister);
            if (contentRegister) contentRegister.classList.toggle('hidden', !isRegister);

            if (tabLoginBtn && tabRegisterBtn) {
                if (isRegister) {
                    tabLoginBtn.className = "flex-1 py-2 px-3 text-xs font-semibold rounded-xl transition-all duration-200 text-[var(--text-muted)] hover:text-[var(--text-main)] flex items-center justify-center gap-1.5";
                    tabRegisterBtn.className = "flex-1 py-2 px-3 text-xs font-bold rounded-xl transition-all duration-200 bg-[var(--bg-surface)] text-[var(--text-main)] shadow-xs flex items-center justify-center gap-1.5";
                } else {
                    tabRegisterBtn.className = "flex-1 py-2 px-3 text-xs font-semibold rounded-xl transition-all duration-200 text-[var(--text-muted)] hover:text-[var(--text-main)] flex items-center justify-center gap-1.5";
                    tabLoginBtn.className = "flex-1 py-2 px-3 text-xs font-bold rounded-xl transition-all duration-200 bg-[var(--bg-surface)] text-[var(--text-main)] shadow-xs flex items-center justify-center gap-1.5";
                }
            }

            if (isRegister) {
                const regFullName = document.getElementById('regFullName');
                if (regFullName) setTimeout(() => regFullName.focus(), 60);
            } else {
                const loginUser = document.getElementById('loginUsername');
                if (loginUser) setTimeout(() => loginUser.focus(), 60);
            }
        }

        function toggleRegisterPasswordVisibility(inputId, iconId) {
            const input = document.getElementById(inputId);
            const icon = document.getElementById(iconId);
            if (!input) return;
            if (input.type === 'password') {
                input.type = 'text';
                if (icon) {
                    icon.classList.remove('fa-eye');
                    icon.classList.add('fa-eye-slash');
                }
            } else {
                input.type = 'password';
                if (icon) {
                    icon.classList.remove('fa-eye-slash');
                    icon.classList.add('fa-eye');
                }
            }
        }

        function toggleRegDbOptions() {
            const isCustom = document.querySelector('input[name="regDbOption"]:checked')?.value === 'custom';
            const container = document.getElementById('regCustomSheetContainer');
            if (container) {
                if (isCustom) {
                    container.classList.remove('hidden');
                    const inp = document.getElementById('regCustomSheetUrl');
                    if (inp) setTimeout(() => inp.focus(), 60);
                } else {
                    container.classList.add('hidden');
                }
            }
        }

        /* MODAL BACKEND PENGATURAN DI LAYAR LOGIN */
        function openLoginBackendModal() {
            const modal = document.getElementById('loginBackendModal');
            const inp = document.getElementById('modalSettingsGasUrl');
            const statusText = document.getElementById('modalGasStatusText');
            const currentUrl = getActiveGasApiUrl();

            if (inp) inp.value = currentUrl;
            if (statusText) {
                if (currentUrl) {
                    statusText.className = "font-bold text-emerald-500";
                    statusText.innerHTML = `<i class="fa-solid fa-circle-check"></i> URL Tersimpan`;
                } else {
                    statusText.className = "font-bold text-amber-500";
                    statusText.innerText = "Mode Standalone (Offline)";
                }
            }
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        }

        function closeLoginBackendModal() {
            const modal = document.getElementById('loginBackendModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        async function verifyAndPingBackendUrl(rawUrl) {
            const cleanUrl = sanitizeGasUrl(rawUrl);
            if (!cleanUrl) {
                throw new Error("Masukkan URL Web App Google Apps Script terlebih dahulu.");
            }
            if (!cleanUrl.startsWith("https://script.google.com/macros/s/")) {
                throw new Error("Format URL tidak valid. URL harus diawali dengan 'https://script.google.com/macros/s/' dan berakhiran '/exec'.");
            }

            // 1. Uji koneksi metode POST (text/plain no-preflight)
            try {
                const response = await fetch(cleanUrl, {
                    method: 'POST',
                    mode: 'cors',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({ action: 'ping' }),
                    redirect: 'follow'
                });
                if (response.ok) {
                    const result = await response.json();
                    if (result && result.success) {
                        return { success: true, url: cleanUrl, data: result };
                    }
                }
            } catch(postErr) {
                console.warn("Uji POST ping gagal, mencoba fallback GET ping...", postErr);
            }

            // 2. Fallback uji koneksi metode GET
            try {
                const getUrl = cleanUrl + (cleanUrl.includes('?') ? '&' : '?') + 'ping=true&t=' + Date.now();
                const getResp = await fetch(getUrl, {
                    method: 'GET',
                    mode: 'cors',
                    redirect: 'follow'
                });
                if (getResp.ok) {
                    const result = await getResp.json();
                    if (result && result.success) {
                        return { success: true, url: cleanUrl, data: result };
                    }
                }
            } catch(getErr) {
                console.warn("Uji GET ping gagal:", getErr);
            }

            throw new Error("Gagal terhubung ke Web App. Pastikan saat Deploy di Google Apps Script, opsi 'Who has access' dipilih 'Anyone' (Siapa saja).");
        }

        async function testAndSaveGasUrlFromModal() {
            const inp = document.getElementById('modalSettingsGasUrl');
            const rawUrl = inp ? inp.value.trim() : "";
            const statusText = document.getElementById('modalGasStatusText');

            if (!rawUrl) {
                showToast("Masukkan URL Google Apps Script Web App terlebih dahulu.");
                return;
            }

            if (statusText) {
                statusText.className = "font-bold text-slate-500";
                statusText.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Menguji koneksi & keamanan...`;
            }

            try {
                showToast("Menguji koneksi ke Google Apps Script...");
                const check = await verifyAndPingBackendUrl(rawUrl);

                if (inp) inp.value = check.url;
                safeStorage.setItem('saturuma_gas_api_url', check.url);
                if (window.APP_CONFIG) window.APP_CONFIG.GAS_API_URL = check.url;

                if (statusText) {
                    statusText.className = "font-bold text-emerald-500";
                    statusText.innerHTML = `<i class="fa-solid fa-circle-check"></i> Terhubung Sukses`;
                }
                showToast("Berhasil terhubung ke Google Apps Script backend!");
                updateAuthCloudBadge();
                setTimeout(() => closeLoginBackendModal(), 1200);
            } catch (err) {
                if (statusText) {
                    statusText.className = "font-bold text-rose-500";
                    statusText.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Gagal Terhubung`;
                }
                showToast("Gagal: " + err.message);
            }
        }

        function disconnectGasUrlFromModal() {
            safeStorage.removeItem('saturuma_gas_api_url');
            if (window.APP_CONFIG) window.APP_CONFIG.GAS_API_URL = "";
            const inp = document.getElementById('modalSettingsGasUrl');
            if (inp) inp.value = "";
            const statusText = document.getElementById('modalGasStatusText');
            if (statusText) {
                statusText.className = "font-bold text-amber-500";
                statusText.innerText = "Mode Standalone (Offline)";
            }
            showToast("Koneksi backend diputuskan. Beralih ke mode offline.");
            updateAuthCloudBadge();
        }

        function updateAuthCloudBadge() {
            const badge = document.getElementById('authCloudStatusBadge');
            const text = document.getElementById('authCloudStatusText');
            const url = getActiveGasApiUrl();

            if (badge && text) {
                if (url) {
                    badge.className = "inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[11px] font-bold mt-2 bg-emerald-500/10 text-emerald-600 border border-emerald-500/20";
                    text.innerText = "Cloud Backend Terhubung";
                } else {
                    badge.className = "inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[11px] font-bold mt-2 bg-amber-500/10 text-amber-600 border border-amber-500/20";
                    text.innerText = "Mode Offline / Standalone";
                }
            }
        }

        /* REGISTRATION SUBMISSION */
        function handleRegisterSubmit(e) {
            if (e) e.preventDefault();
            const fullName = document.getElementById('regFullName')?.value?.trim();
            const username = document.getElementById('regUsername')?.value?.trim();
            const password = document.getElementById('regPassword')?.value?.trim();
            const passwordConfirm = document.getElementById('regPasswordConfirm')?.value?.trim();
            const isCustomDb = document.querySelector('input[name="regDbOption"]:checked')?.value === 'custom';
            const customSheetUrl = isCustomDb ? (document.getElementById('regCustomSheetUrl')?.value?.trim() || "") : "";
            const geminiApiKey = document.getElementById('regGeminiKey')?.value?.trim() || "";

            if (!fullName || !username || !password) {
                showLoginError("Nama lengkap, username, dan kata sandi wajib diisi!");
                return;
            }

            if (username.length < 3 || username.includes(" ")) {
                showLoginError("Username minimal 3 karakter dan tidak boleh mengandung spasi.");
                return;
            }

            if (password.length < 4) {
                showLoginError("Kata sandi minimal 4 karakter.");
                return;
            }

            if (password !== passwordConfirm) {
                showLoginError("Konfirmasi kata sandi tidak cocok. Silakan periksa kembali.");
                return;
            }

            const btn = document.getElementById('btnRegisterSubmit');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> <span>Mendaftarkan akun...</span>`;
            }

            const payload = {
                fullName: fullName,
                username: username,
                password: password,
                customSpreadsheetUrl: "",
                geminiApiKey: geminiApiKey
            };

            function resetRegBtn() {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = `<i class="fa-solid fa-user-plus"></i> <span>Daftarkan Akun & Mulai Mencatat</span>`;
                }
            }

            try {
                if (typeof google !== 'undefined' && google.script && google.script.run) {
                    google.script.run
                        .withSuccessHandler(function(resp) {
                            resetRegBtn();
                            if (resp && resp.success) {
                                showToast(resp.message || "Pendaftaran berhasil!");
                                onLoginSuccess(resp, true);
                            } else {
                                showLoginError(resp ? resp.message : "Pendaftaran gagal.");
                            }
                        })
                        .withFailureHandler(function(err) {
                            resetRegBtn();
                            showLoginError("Gagal menghubungi server backend: " + (err.message || err));
                        })
                        .registerUser(payload);
                } else {
                    // Standalone Mock Mode Registration
                    setTimeout(() => {
                        resetRegBtn();
                        const mockUserId = "USR_MOCK_" + Date.now();
                        const mockResp = {
                            success: true,
                            sessionToken: "mock_token_" + Date.now(),
                            user: {
                                userId: mockUserId,
                                username: username,
                                fullName: fullName,
                                role: "member",
                                customSpreadsheetId: customSheetUrl ? "MOCK_CUSTOM_SHEET" : "",
                                geminiApiKey: geminiApiKey,
                                lastLogin: new Date().toLocaleString('id-ID')
                            }
                        };
                        if (geminiApiKey) safeStorage.setItem('saturuma_gemini_key', geminiApiKey);

                        // Simpan akun ke database mock lokal agar bisa login kembali saat offline
                        try {
                            const rawMockUsers = safeStorage.getItem('saturuma_mock_users') || '[]';
                            const mockUsers = JSON.parse(rawMockUsers);
                            // Cek jika username sudah ada di mock
                            const existingIdx = mockUsers.findIndex(u => u.username && u.username.toLowerCase() === username.toLowerCase());
                            if (existingIdx >= 0) {
                                mockUsers[existingIdx] = { username: username, password: password, user: mockResp.user };
                            } else {
                                mockUsers.push({ username: username, password: password, user: mockResp.user });
                            }
                            safeStorage.setItem('saturuma_mock_users', JSON.stringify(mockUsers));
                        } catch(saveMockErr) {
                            console.warn("Gagal menyimpan akun mock lokal:", saveMockErr);
                        }

                        showToast(`Akun '${username}' berhasil dibuat!`);
                        onLoginSuccess(mockResp, true);
                    }, 400);
                }
            } catch (regErr) {
                console.error("handleRegisterSubmit Exception:", regErr);
                resetRegBtn();
                showLoginError("Kendala saat mendaftar: " + (regErr.message || regErr));
            }
        }

        function fillDemoCredentials() {
            const u = document.getElementById('loginUsername');
            const p = document.getElementById('loginPassword');
            if (u) u.value = 'admin';
            if (p) p.value = 'admin 123';
            const err = document.getElementById('loginErrorBox');
            if (err) err.classList.add('hidden');
            showToast("Kredensial demo (admin / admin 123) telah diisikan!");
            if (p) p.focus();
        }

        function disconnectBackendFromLogin() {
            safeStorage.removeItem('saturuma_gas_api_url');
            if (window.APP_CONFIG) window.APP_CONFIG.GAS_API_URL = "";
            safeStorage.removeItem('saturuma_session');
            try { sessionStorage.removeItem('saturuma_session_temp'); } catch(e) {}

            const u = document.getElementById('loginUsername');
            const p = document.getElementById('loginPassword');
            if (u) u.value = 'admin';
            if (p) p.value = 'admin 123';

            const err = document.getElementById('loginErrorBox');
            if (err) err.classList.add('hidden');

            showToast("Koneksi backend diputuskan. Beralih ke mode offline lokal...", 3000);
            setTimeout(() => {
                handleLoginSubmit();
            }, 300);
        }

        function toggleLoginPasswordVisibility() {
            const p = document.getElementById('loginPassword');
            const icon = document.getElementById('loginPassEyeIcon');
            if (!p) return;
            if (p.type === 'password') {
                p.type = 'text';
                if (icon) {
                    icon.classList.remove('fa-eye');
                    icon.classList.add('fa-eye-slash');
                }
            } else {
                p.type = 'password';
                if (icon) {
                    icon.classList.remove('fa-eye-slash');
                    icon.classList.add('fa-eye');
                }
            }
        }

        function showLoginError(msg) {
            const errBox = document.getElementById('loginErrorBox');
            const errMsg = document.getElementById('loginErrorMsg');
            const card = document.getElementById('authCard');
            if (errMsg) errMsg.innerText = msg || "Username atau kata sandi tidak valid.";
            if (errBox) errBox.classList.remove('hidden');
            if (card) {
                card.classList.remove('auth-shake');
                void card.offsetWidth; // trigger reflow CSS animation
                card.classList.add('auth-shake');
            }
        }

        function resetLoginBtn() {
            const btn = document.getElementById('btnLoginSubmit');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<i class="fa-solid fa-arrow-right-to-bracket"></i> <span>Masuk ke Saturuma</span>`;
            }
        }

        function handleLoginSubmit(e) {
            if (e) e.preventDefault();
            const username = document.getElementById('loginUsername')?.value?.trim();
            const password = document.getElementById('loginPassword')?.value?.trim();
            const remember = document.getElementById('loginRememberMe')?.checked;
            const btn = document.getElementById('btnLoginSubmit');
            const errBox = document.getElementById('loginErrorBox');

            if (!username || !password) {
                showLoginError("Username dan kata sandi wajib diisi!");
                return;
            }

            if (errBox) errBox.classList.add('hidden');
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> <span>Memverifikasi...</span>`;
            }

            try {
                // Google Apps Script Backend Execution
                if (typeof google !== 'undefined' && google.script && google.script.run) {
                    google.script.run
                        .withSuccessHandler(function(resp) {
                            resetLoginBtn();
                            if (resp && resp.success) {
                                onLoginSuccess(resp, remember);
                            } else {
                                showLoginError((resp && resp.message) ? resp.message : "Username atau kata sandi tidak sesuai.");
                            }
                        })
                        .withFailureHandler(function(err) {
                            resetLoginBtn();
                            const errMsg = (err && err.message) || String(err);
                            showLoginError("Gagal menghubungi server: " + errMsg + ". Periksa koneksi atau masuk Mode Offline jika backend belum aktif.");
                        })
                        .verifyUserLogin(username, password);
                } else {
                    // Standalone Mock Mode
                    setTimeout(() => {
                        resetLoginBtn();
                        const isDemoAdmin = username.toLowerCase() === 'admin' && (password === 'admin 123' || password === 'admin123');
                        if (isDemoAdmin) {
                            const mockResp = {
                                success: true,
                                sessionToken: "mock_token_" + Date.now(),
                                user: {
                                    userId: "USR_0001",
                                    username: "admin",
                                    fullName: "Administrator Saturuma",
                                    role: "admin",
                                    customSpreadsheetId: "",
                                    geminiApiKey: "",
                                    lastLogin: new Date().toLocaleString('id-ID')
                                }
                            };
                            onLoginSuccess(mockResp, remember);
                            return;
                        }

                        // Periksa akun yang didaftarkan di mode lokal offline
                        try {
                            const rawMockUsers = safeStorage.getItem('saturuma_mock_users') || '[]';
                            const mockUsers = JSON.parse(rawMockUsers);
                            const found = mockUsers.find(u => u.username && u.username.toLowerCase() === username.toLowerCase() && u.password === password);
                            if (found) {
                                const mockResp = {
                                    success: true,
                                    sessionToken: "mock_token_" + Date.now(),
                                    user: found.user
                                };
                                showToast(`Selamat datang kembali, ${found.user.fullName || found.user.username}!`);
                                onLoginSuccess(mockResp, remember);
                                return;
                            }
                        } catch(checkMockErr) {
                            console.warn("Gagal mengecek akun mock lokal:", checkMockErr);
                        }

                        showLoginError("Username atau kata sandi salah! Belum punya akun? Klik menu 'Daftar Akun Baru'.");
                    }, 400);
                }
            } catch (err) {
                console.error("handleLoginSubmit Exception:", err);
                resetLoginBtn();
                showLoginError("Kendala saat memproses login: " + (err.message || err));
            }
        }

        function onLoginSuccess(resp, remember, isSilent = false) {
            state.currentUser = resp.user;
            state.sessionToken = resp.sessionToken;

            // Simpan sesi
            const sessionPayload = {
                token: resp.sessionToken,
                user: resp.user,
                savedAt: Date.now()
            };

            if (remember) {
                safeStorage.setItem('saturuma_session', JSON.stringify(sessionPayload));
                try { sessionStorage.removeItem('saturuma_session_temp'); } catch(e) {}
            } else {
                try {
                    sessionStorage.setItem('saturuma_session_temp', JSON.stringify(sessionPayload));
                } catch(e) {}
                safeStorage.removeItem('saturuma_session');
            }

            // Tandai status sesi pada root HTML
            document.documentElement.classList.add('has-session');

            // Update UI User Profile
            renderUserProfile();

            // Sembunyikan layar login
            const overlay = document.getElementById('authOverlay');
            if (overlay) {
                if (isSilent) {
                    overlay.classList.add('hidden');
                } else {
                    overlay.classList.add('opacity-0', 'pointer-events-none');
                    setTimeout(() => {
                        overlay.classList.add('hidden');
                        overlay.classList.remove('opacity-0', 'pointer-events-none');
                    }, 300);
                }
            }

            if (!isSilent) {
                showToast(`Selamat datang kembali, ${resp.user.fullName || resp.user.username}!`);
            }

            // Muat data transaksi & dashboard
            loadEntriesFromBackend();
        }

        function handleLogout() {
            openLogoutModal();
        }

        function openLogoutModal() {
            if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
            const modal = document.getElementById('logoutConfirmModal');
            if (modal) {
                const user = state.currentUser || { username: 'admin', fullName: 'Administrator' };
                const userEl = document.getElementById('logoutModalUserName');
                if (userEl) {
                    userEl.innerText = user.fullName || user.username || 'Pengguna';
                }
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        }

        function closeLogoutConfirmModal() {
            const modal = document.getElementById('logoutConfirmModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        function executeLogout() {
            closeLogoutConfirmModal();

            if (state.sessionToken && typeof google !== 'undefined' && google.script && google.script.run) {
                google.script.run.logoutUser(state.sessionToken);
            }

            safeStorage.removeItem('saturuma_session');
            try { sessionStorage.removeItem('saturuma_session_temp'); } catch(e) {}

            document.documentElement.classList.remove('has-session');

            state.currentUser = null;
            state.sessionToken = null;

            const passInp = document.getElementById('loginPassword');
            if (passInp) passInp.value = '';

            const overlay = document.getElementById('authOverlay');
            if (overlay) {
                overlay.classList.remove('hidden');
                overlay.classList.remove('opacity-0', 'pointer-events-none');
            }

            showToast("Anda telah berhasil keluar.");
        }

        function checkUserSession() {
            let saved = null;
            let isTemp = false;

            try {
                const rawTemp = sessionStorage.getItem('saturuma_session_temp');
                if (rawTemp) {
                    saved = JSON.parse(rawTemp);
                    isTemp = true;
                }
            } catch(e) {}

            if (!saved) {
                try {
                    const raw = safeStorage.getItem('saturuma_session');
                    if (raw) saved = JSON.parse(raw);
                } catch(e) {}
            }

            const overlay = document.getElementById('authOverlay');

            if (!saved || !saved.token || !saved.user) {
                document.documentElement.classList.remove('has-session');
                if (overlay) {
                    overlay.classList.remove('hidden');
                    overlay.classList.remove('opacity-0', 'pointer-events-none');
                }
                return;
            }

            // Validasi token sesi dengan backend
            try {
                if (typeof google !== 'undefined' && google.script && google.script.run) {
                    google.script.run
                        .withSuccessHandler(function(resp) {
                            if (resp && resp.success) {
                                onLoginSuccess({
                                    sessionToken: saved.token,
                                    user: resp.user || saved.user
                                }, !isTemp, true);
                            } else {
                                safeStorage.removeItem('saturuma_session');
                                try { sessionStorage.removeItem('saturuma_session_temp'); } catch(e) {}
                                document.documentElement.classList.remove('has-session');
                                if (overlay) {
                                    overlay.classList.remove('hidden');
                                    overlay.classList.remove('opacity-0', 'pointer-events-none');
                                }
                                showLoginError((resp && resp.message) ? resp.message : "Sesi login telah kedaluwarsa. Silakan masuk kembali.");
                            }
                        })
                        .withFailureHandler(function() {
                            // Jika offline atau server lambat, izinkan fallback sesi
                            onLoginSuccess({
                                sessionToken: saved.token,
                                user: saved.user
                            }, !isTemp, true);
                        })
                        .validateSession(saved.token);
                } else {
                    onLoginSuccess({
                        sessionToken: saved.token,
                        user: saved.user
                    }, !isTemp, true);
                }
            } catch (sessErr) {
                console.warn("checkUserSession exception:", sessErr);
                onLoginSuccess({
                    sessionToken: saved.token,
                    user: saved.user
                }, !isTemp, true);
            }
        }

        function renderUserProfile() {
            const user = state.currentUser || { username: 'admin', fullName: 'Administrator', role: 'admin' };
            
            // Sidebar
            const sName = document.getElementById('sidebarUserName');
            const sRole = document.getElementById('sidebarUserRole');
            if (sName) sName.innerText = user.fullName || user.username || 'Administrator';
            if (sRole) sRole.innerText = (user.role || 'Admin').toUpperCase();

            // Top Bar
            const tBadge = document.getElementById('topBarUserBadge');
            if (tBadge) tBadge.innerText = user.username || 'Keluar';

            // Settings Section
            const setUName = document.getElementById('settingsCurrentUserName');
            const setURole = document.getElementById('settingsCurrentUserRole');
            const setRoleBadge = document.getElementById('settingsCurrentUserRoleBadge');
            const profFullName = document.getElementById('profileFullNameInput');
            const profUsername = document.getElementById('profileUsernameInput');

            if (setUName) setUName.innerText = user.fullName || user.username || 'Administrator';
            if (setURole) setURole.innerText = `@${user.username} • Role: ${user.role || 'admin'}`;
            if (setRoleBadge) setRoleBadge.innerText = user.role || 'admin';
            if (profFullName && (!profFullName.value || profFullName.value === 'Administrator')) {
                profFullName.value = user.fullName || user.username || 'Administrator';
            }
            if (profUsername) profUsername.value = user.username || 'admin';

            // Sync link to Spreadsheet
            const linkSpreadsheet = document.getElementById('btnMetaSpreadsheetLink')?.href;
            const btnUserSheet = document.getElementById('btnOpenUserSheetLink');
            if (btnUserSheet && linkSpreadsheet && linkSpreadsheet !== '#') {
                btnUserSheet.href = linkSpreadsheet;
            }
        }

        /* ---------------- SISTEM TAB & NAVIGASI MENU PENGATURAN (RINGKAS) ---------------- */
        const SETTINGS_TABS = ['appearance', 'account', 'cloud', 'categories'];
        const SETTINGS_ACCORDION_SECTIONS = ['theme', 'categories', 'profile', 'password', 'api', 'backend', 'badge'];

        function switchSettingsTab(tabId) {
            if (!SETTINGS_TABS.includes(tabId)) {
                // Map legacy accordion names to tabs
                const sectionToTabMap = {
                    theme: 'appearance',
                    badge: 'appearance',
                    profile: 'account',
                    password: 'account',
                    api: 'cloud',
                    backend: 'cloud',
                    categories: 'categories'
                };
                tabId = sectionToTabMap[tabId] || 'appearance';
            }

            SETTINGS_TABS.forEach(t => {
                const btn = document.getElementById(`settings-tab-btn-${t}`);
                const pane = document.getElementById(`settings-pane-${t}`);

                if (btn) {
                    if (t === tabId) {
                        btn.className = "settings-tab-btn active py-2 sm:py-2.5 px-1 rounded-xl text-center flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 transition-all bg-[var(--primary)] text-white font-bold shadow-xs";
                    } else {
                        btn.className = "settings-tab-btn py-2 sm:py-2.5 px-1 rounded-xl text-center flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 transition-all text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--border-color)]/20 font-semibold";
                    }
                }

                if (pane) {
                    if (t === tabId) {
                        pane.classList.remove('hidden');
                    } else {
                        pane.classList.add('hidden');
                    }
                }
            });

            safeStorage.setItem('saturuma_active_settings_tab', tabId);
        }

        function toggleSettingsAccordion(sectionId) {
            const sectionToTabMap = {
                theme: 'appearance',
                badge: 'appearance',
                profile: 'account',
                password: 'account',
                api: 'cloud',
                backend: 'cloud',
                categories: 'categories',
                appearance: 'appearance',
                account: 'account',
                cloud: 'cloud'
            };

            const targetTab = sectionToTabMap[sectionId] || 'appearance';
            switchSettingsTab(targetTab);

            const targetCard = document.getElementById(`settings-card-${sectionId}`);
            if (targetCard) {
                targetCard.classList.add('ring-2', 'ring-[var(--primary)]/50');
                setTimeout(() => {
                    targetCard.classList.remove('ring-2', 'ring-[var(--primary)]/50');
                }, 1200);
                try {
                    targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                } catch(e) {}
            }
        }

        function closeAllSettingsAccordion() {
            // Dilayani oleh sistem tab ringkas
        }

        function openAllSettingsAccordion() {
            // Dilayani oleh sistem tab ringkas
        }

        function filterSettingsSection(sectionId) {
            toggleSettingsAccordion(sectionId);
        }

        // Backward compatibility
        function toggleSettingsCollapsible(sectionId, forceState) {
            toggleSettingsAccordion(sectionId);
        }

        function toggleAllSettingsCollapsibles(shouldOpen) {
            if (!shouldOpen) closeAllSettingsAccordion();
            else toggleSettingsAccordion('categories');
        }

        function switchUserSettingsTab(tab) {
            toggleSettingsAccordion(tab);
        }

        function handleUpdateProfileSubmit(e) {
            if (e) e.preventDefault();
            const fullNameInp = document.getElementById('profileFullNameInput');
            const newName = fullNameInp ? fullNameInp.value.trim() : '';
            if (!newName) {
                showToast("Nama tampilan tidak boleh kosong.", "warning");
                return;
            }
            if (!state.currentUser) {
                state.currentUser = { username: 'admin', fullName: newName, role: 'admin' };
            } else {
                state.currentUser.fullName = newName;
            }

            // Simpan ke storage sesi
            try {
                const raw = safeStorage.getItem('saturuma_session');
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed.user) parsed.user.fullName = newName;
                    safeStorage.setItem('saturuma_session', JSON.stringify(parsed));
                }
            } catch(err) {}

            renderUserProfile();
            showToast("Nama profil berhasil diperbarui!", "success");
        }

        function handleChangePasswordSubmit(e) {
            if (e) e.preventDefault();
            const oldPass = document.getElementById('oldPasswordInput')?.value;
            const newPass = document.getElementById('newPasswordInput')?.value;
            const confirmPass = document.getElementById('confirmNewPasswordInput')?.value;
            const btn = document.getElementById('btnChangePassSubmit');

            if (!oldPass || !newPass || !confirmPass) {
                showToast("Semua field kata sandi wajib diisi!");
                return;
            }

            if (newPass.length < 6) {
                showToast("Kata sandi baru minimal harus 6 karakter!");
                return;
            }

            if (newPass !== confirmPass) {
                showToast("Konfirmasi kata sandi baru tidak sesuai!");
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Memproses...`;
            }

            if (typeof google !== 'undefined' && google.script && google.script.run) {
                google.script.run
                    .withSuccessHandler(function(resp) {
                        if (btn) {
                            btn.disabled = false;
                            btn.innerHTML = `<i class="fa-solid fa-key"></i> <span>Simpan Password Baru</span>`;
                        }
                        if (resp && resp.success) {
                            showToast(resp.message || "Password berhasil diubah!");
                            document.getElementById('changePasswordForm')?.reset();
                        } else {
                            showToast("Gagal: " + (resp ? resp.message : "Kesalahan sistem"));
                        }
                    })
                    .withFailureHandler(function(err) {
                        if (btn) {
                            btn.disabled = false;
                            btn.innerHTML = `<i class="fa-solid fa-key"></i> <span>Simpan Password Baru</span>`;
                        }
                        showToast("Error: " + (err.message || err));
                    })
                    .changeCurrentUserPassword(state.sessionToken, oldPass, newPass);
            } else {
                setTimeout(() => {
                    if (btn) {
                        btn.disabled = false;
                        btn.innerHTML = `<i class="fa-solid fa-key"></i> <span>Simpan Password Baru</span>`;
                    }
                    showToast("Password berhasil diperbarui (Simulasi Lokal)!");
                    document.getElementById('changePasswordForm')?.reset();
                }, 500);
            }
        }

        /* ========================================================
           1. SISTEM AKSENTUASI WARNA DINAMIS & TEMA
           ======================================================== */
        function hexToRgba(hex, alpha) {
            let c = hex.replace('#', '');
            if (c.length === 3) c = c.split('').map(x => x + x).join('');
            const num = parseInt(c, 16);
            const r = (num >> 16) & 255;
            const g = (num >> 8) & 255;
            const b = num & 255;
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        // Modern Category Card Border (5 Prinsip: Thin & Subtle, Radius 16px, Accent Left Border, Tanpa Glow, Shadow Mengikuti Aksen Kategori)
        function getCategoryCardStyle(color, options = {}) {
            const hex = color || '#10B981';
            const borderW = options.borderLeftWidth || '5px';
            const radius = options.radius || '16px';
            const bColor = hexToRgba(hex, 0.35);
            const s1 = hexToRgba(hex, 0.12);
            const s2 = hexToRgba(hex, 0.05);
            const sHover1 = hexToRgba(hex, 0.20);
            const sHover2 = hexToRgba(hex, 0.08);
            return `--cat-color: ${hex}; --cat-border: ${bColor}; --cat-shadow: 0 4px 14px -2px ${s1}, 0 1px 3px 0 ${s2}; --cat-shadow-hover: 0 8px 20px -3px ${sHover1}, 0 2px 6px 0 ${sHover2}; border-radius: ${radius}; border-color: ${bColor}; border-left: ${borderW} solid ${hex}; box-shadow: 0 4px 14px -2px ${s1}, 0 1px 3px 0 ${s2};`;
        }

        function adjustColorBrightness(hex, percent) {
            let num = parseInt(hex.replace('#', ''), 16),
                amt = Math.round(2.55 * percent),
                R = (num >> 16) + amt,
                G = (num >> 8 & 0x00FF) + amt,
                B = (num & 0x0000FF) + amt;
            return '#' + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 + (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 + (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1);
        }

        function applyDynamicAccentColor(hexColor) {
            const root = document.documentElement;
            const primary = hexColor || "#10B981";
            const hover = adjustColorBrightness(primary, -12);
            const light = hexToRgba(primary, 0.14);
            const glow = hexToRgba(primary, 0.35);
            const border = hexToRgba(primary, 0.32);

            root.style.setProperty('--primary', primary);
            root.style.setProperty('--primary-hover', hover);
            root.style.setProperty('--primary-light', light);
            root.style.setProperty('--primary-glow', glow);
            root.style.setProperty('--primary-border', border);

            const themeMeta = document.querySelector('meta[name="theme-color"]');
            if (themeMeta) themeMeta.setAttribute('content', primary);
        }

        function setTheme(themeName, silent = false) {
            if (!['light', 'dark', 'brutalism'].includes(themeName)) {
                themeName = 'light';
            }
            document.body.classList.remove('theme-light', 'theme-dark', 'theme-brutalism');
            document.body.classList.add('theme-' + themeName);
            document.documentElement.classList.remove('theme-light', 'theme-dark', 'theme-brutalism');
            document.documentElement.classList.add('theme-' + themeName);
            if (themeName === 'dark') {
                document.documentElement.classList.add('dark');
            } else {
                document.documentElement.classList.remove('dark');
            }
            safeStorage.setItem('saturuma_theme', themeName);
            updateThemeUI(themeName);
            if (!silent) {
                const labels = {
                    light: 'Mode Terang (Light)',
                    dark: 'Mode Gelap (Dark)',
                    brutalism: 'Neo-Brutalism'
                };
                showToast(`Tema diubah ke ${labels[themeName] || themeName}`);
            }
        }

        function updateThemeUI(themeName) {
            if (!themeName) {
                themeName = safeStorage.getItem('saturuma_theme') || 'light';
            }
            const themes = ['light', 'dark', 'brutalism'];

            // 1. Sinkronisasi Tombol Tema di Sidebar
            themes.forEach(t => {
                const idName = 'sidebarTheme' + t.charAt(0).toUpperCase() + t.slice(1);
                const btn = document.getElementById(idName);
                if (btn) {
                    if (t === themeName) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                }
            });

            // 2. Sinkronisasi Tombol Tema di Layar Login Otentikasi
            themes.forEach(t => {
                const idName = 'authTheme' + t.charAt(0).toUpperCase() + t.slice(1);
                const btn = document.getElementById(idName);
                if (btn) {
                    if (t === themeName) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                }
            });

            // 3. Sinkronisasi Kartu Pilihan Tema & Badge di Menu Pengaturan
            const themeBadge = document.getElementById('settingsThemeBadge');
            if (themeBadge) {
                const badgeMap = {
                    light: { text: 'Mode Terang (Aktif)', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
                    dark: { text: 'Mode Gelap (Aktif)', cls: 'bg-indigo-500/10 text-indigo-500 dark:text-indigo-400 border-indigo-500/20' },
                    brutalism: { text: 'Neo-Brutalism (Aktif)', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' }
                };
                const conf = badgeMap[themeName] || badgeMap.light;
                themeBadge.innerText = conf.text;
                themeBadge.className = `text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${conf.cls}`;
            }

            themes.forEach(t => {
                const card = document.getElementById(`theme-card-${t}`);
                const statusBadge = document.getElementById(`theme-badge-${t}`);
                const radioDot = document.getElementById(`theme-radio-${t}`);

                if (card) {
                    if (t === themeName) {
                        card.classList.add('active');
                    } else {
                        card.classList.remove('active');
                    }
                }

                if (statusBadge) {
                    if (t === themeName) {
                        statusBadge.innerHTML = '<i class="fa-solid fa-check text-[9px]"></i> Aktif';
                        statusBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--primary)] text-white flex items-center gap-1 shadow-2xs';
                    } else {
                        statusBadge.innerText = 'Pilih Tema';
                        statusBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-semibold text-[var(--text-muted)] bg-[var(--bg-surface)] border border-[var(--border-color)]';
                    }
                }

                if (radioDot) {
                    if (t === themeName) {
                        radioDot.className = 'w-4 h-4 rounded-full border-2 border-[var(--primary)] bg-[var(--primary)] flex items-center justify-center text-white text-[9px] shadow-xs';
                        radioDot.innerHTML = '<i class="fa-solid fa-check"></i>';
                    } else {
                        radioDot.className = 'w-4 h-4 rounded-full border-2 border-[var(--border-color)] bg-transparent flex items-center justify-center';
                        radioDot.innerHTML = '';
                    }
                }
            });

            // 4. Sinkronisasi Favicon Dinamis Sesuai Tema Aktif
            try {
                const favAlt = document.querySelector('link[rel="alternate icon"]');
                if (favAlt) {
                    if (themeName === 'dark') {
                        favAlt.href = 'icons/favicon-dark.png';
                    } else if (themeName === 'brutalism') {
                        favAlt.href = 'icons/favicon-brutal.png';
                    } else {
                        favAlt.href = 'icons/favicon-light.png';
                    }
                }
            } catch(e) {}
        }

        /* ---------------- PENGATURAN MODERN CARD BORDER (5 PRINSIP) ---------------- */
        const CARD_BORDER_STYLES = [
            {
                id: 'category-accent',
                name: 'Border Kategori',
                badge: 'Default Aktif',
                desc: 'Border 1px halus, radius 16px, border aksen kategori, tanpa glow, & shadow warna kategori.'
            },
            {
                id: 'thin-subtle',
                name: 'Thin & Subtle',
                badge: '1px Netral',
                desc: 'Border 1px abu-abu netral (#E5E7EB / #374151) seragam, radius 16px, minimalis dan bersih.'
            },
            {
                id: 'gradient-border',
                name: 'Gradient Border',
                badge: 'Gradien Ungu-Biru',
                desc: 'Teknik background-clip gradien #8B5CF6 ke #3B82F6 modern dengan pendaran hover elegan.'
            },
            {
                id: 'hover-glow',
                name: 'Hover Glow Animation',
                badge: 'Pendaran Halus',
                desc: 'Pendaran cahaya glow animasi emerald interaktif saat kursor menyentuh kartu.'
            },
            {
                id: 'borderless',
                name: 'Shadow-First / Borderless',
                badge: 'Tanpa Border Fisik',
                desc: 'Tanpa garis border fisik, mengandalkan kedalaman elevasi box-shadow bertingkat & kontras latar kanvas.'
            }
        ];

        function setCardBorderStyle(styleId, silent = false) {
            const validIds = CARD_BORDER_STYLES.map(s => s.id);
            if (!validIds.includes(styleId)) {
                styleId = 'category-accent'; // Default bawaan yang saat ini teraplikasikan
            }

            validIds.forEach(id => {
                document.body.classList.remove('card-style-' + id);
                document.documentElement.classList.remove('card-style-' + id);
            });
            document.body.classList.add('card-style-' + styleId);
            document.documentElement.classList.add('card-style-' + styleId);

            safeStorage.setItem('saturuma_card_border', styleId);
            updateCardBorderUI(styleId);

            if (!silent) {
                const found = CARD_BORDER_STYLES.find(s => s.id === styleId);
                showToast(`Gaya Card Border diubah ke: ${found ? found.name : styleId}`);
            }
        }

        function updateCardBorderUI(currentStyle) {
            if (!currentStyle) {
                currentStyle = safeStorage.getItem('saturuma_card_border') || 'category-accent';
            }

            const currentConf = CARD_BORDER_STYLES.find(s => s.id === currentStyle) || CARD_BORDER_STYLES[0];

            // 1. Sinkronisasi Header Accordion Badge & Subtitle
            const headerBadge = document.getElementById('settingsCardBorderBadge');
            if (headerBadge) {
                if (currentStyle === 'category-accent') {
                    headerBadge.innerText = 'Border Kategori (Default)';
                    headerBadge.className = 'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20';
                } else {
                    headerBadge.innerText = `${currentConf.name} (Aktif)`;
                    headerBadge.className = 'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20';
                }
            }

            const headerDesc = document.getElementById('settingsCardBorderDesc');
            if (headerDesc) {
                headerDesc.innerText = currentConf.desc;
            }

            // 2. Sinkronisasi Masing-Masing Kartu Pilihan
            CARD_BORDER_STYLES.forEach(style => {
                const card = document.getElementById(`cardborder-option-${style.id}`);
                const radio = document.getElementById(`cardborder-radio-${style.id}`);
                const badge = document.getElementById(`cardborder-badge-${style.id}`);

                const isActive = style.id === currentStyle;

                if (card) {
                    if (isActive) card.classList.add('active');
                    else card.classList.remove('active');
                }

                if (radio) {
                    if (isActive) {
                        radio.className = 'w-4 h-4 rounded-full border-2 border-[var(--primary)] bg-[var(--primary)] flex items-center justify-center text-white text-[9px] shadow-xs';
                        radio.innerHTML = '<i class="fa-solid fa-check"></i>';
                    } else {
                        radio.className = 'w-4 h-4 rounded-full border-2 border-[var(--border-color)] bg-transparent flex items-center justify-center';
                        radio.innerHTML = '';
                    }
                }

                if (badge) {
                    if (isActive) {
                        const label = style.id === 'category-accent' ? 'Aktif (Default)' : 'Aktif';
                        badge.innerHTML = `<i class="fa-solid fa-check text-[9px]"></i> ${label}`;
                        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--primary)] text-white flex items-center gap-1 shadow-2xs';
                    } else {
                        badge.innerText = 'Pilih Gaya';
                        badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-semibold text-[var(--text-muted)] bg-[var(--bg-surface)] border border-[var(--border-color)]';
                    }
                }
            });
        }

        /* ---------------- NORMALISASI NAMA MODEL GEMINI ---------------- */
        function normalizeGeminiModelName(model) {
            if (!model || typeof model !== 'string') return 'gemini-3.5-flash-lite';
            const clean = model.trim();
            if (clean === 'unknown' || !clean.startsWith('gemini-')) {
                return 'gemini-3.5-flash-lite';
            }
            return clean;
        }

        /* ---------------- STRICT DATE FORMATTER (YYYY-MM-DD) ---------------- */
        function formatToStrictDateString(raw) {
            const getTodayYmd = () => {
                const now = new Date();
                const y = now.getFullYear();
                const m = String(now.getMonth() + 1).padStart(2, '0');
                const d = String(now.getDate()).padStart(2, '0');
                return `${y}-${m}-${d}`;
            };

            if (!raw) return getTodayYmd();

            if (raw instanceof Date && !isNaN(raw.getTime())) {
                const y = raw.getFullYear();
                const m = String(raw.getMonth() + 1).padStart(2, '0');
                const d = String(raw.getDate()).padStart(2, '0');
                return `${y}-${m}-${d}`;
            }

            let str = String(raw).trim();
            if (!str) return getTodayYmd();

            // Bersihkan jika ada waktu (misal "2026-11-03 14:30:00" atau "2026-11-03T14:30:00Z")
            if (str.includes('T')) str = str.split('T')[0].trim();
            else if (str.includes(' ')) str = str.split(' ')[0].trim();

            // Kasus 1: YYYY-MM-DD standar (4 digit tahun)
            const matchYmd = str.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})$/);
            if (matchYmd) {
                const y = parseInt(matchYmd[1], 10);
                const m = parseInt(matchYmd[2], 10);
                const d = parseInt(matchYmd[3], 10);
                if (y >= 1970 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            // Kasus 2: Tahun cacat / terpotong (misalnya "268-11-03", "26-11-03", "026-11-03")
            const matchCorruptYear = str.match(/^(\d{1,3})[-\/\.](\d{1,2})[-\/\.](\d{1,2})$/);
            if (matchCorruptYear) {
                const yRaw = matchCorruptYear[1];
                let m = parseInt(matchCorruptYear[2], 10);
                let d = parseInt(matchCorruptYear[3], 10);

                let y = new Date().getFullYear();
                if (yRaw.length === 2) {
                    y = 2000 + parseInt(yRaw, 10);
                } else if (yRaw.length === 3) {
                    if (yRaw.startsWith('26') || yRaw.startsWith('20')) {
                        y = 2026;
                    } else {
                        y = 2000 + parseInt(yRaw.slice(-2), 10);
                    }
                } else if (yRaw.length === 1) {
                    y = 2020 + parseInt(yRaw, 10);
                }

                if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            // Kasus 3: DD-MM-YYYY atau DD/MM/YYYY
            const matchDmy = str.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{2,4})$/);
            if (matchDmy) {
                let d = parseInt(matchDmy[1], 10);
                let m = parseInt(matchDmy[2], 10);
                let yRaw = matchDmy[3];
                let y = parseInt(yRaw, 10);

                if (yRaw.length === 2) {
                    y = 2000 + y;
                } else if (yRaw.length === 3) {
                    if (yRaw.startsWith('26') || yRaw.startsWith('20')) y = 2026;
                    else y = 2000 + parseInt(yRaw.slice(-2), 10);
                }

                if (m > 12 && d <= 12) {
                    const tmp = d;
                    d = m;
                    m = tmp;
                }

                if (y >= 1970 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            // Fallback native Date parser
            const parsed = new Date(str);
            if (!isNaN(parsed.getTime())) {
                const y = parsed.getFullYear();
                const m = String(parsed.getMonth() + 1).padStart(2, '0');
                const d = String(parsed.getDate()).padStart(2, '0');
                if (y >= 1970 && y <= 2099) {
                    return `${y}-${m}-${d}`;
                }
            }

            return getTodayYmd();
        }

        /* ---------------- PECAHAN RIBUAN (THOUSAND SEPARATOR ENGINE) ---------------- */
        function formatThousand(val) {
            if (val === null || val === undefined || val === '') return '';
            const clean = String(val).replace(/[^0-9]/g, '');
            if (!clean) return '';
            return parseInt(clean, 10).toLocaleString('id-ID');
        }

        function parseThousand(val) {
            if (!val && val !== 0) return 0;
            const clean = String(val).replace(/[^0-9]/g, '');
            return clean ? parseInt(clean, 10) : 0;
        }

        function parseSignedThousand(val) {
            if (!val && val !== 0) return 0;
            const s = String(val).trim();
            const isNegative = s.startsWith('-');
            const clean = s.replace(/[^0-9]/g, '');
            if (!clean) return 0;
            const num = parseInt(clean, 10);
            return isNegative ? -num : num;
        }

        function formatSignedThousand(val) {
            if (val === null || val === undefined || val === '') return '';
            const num = Number(val);
            if (isNaN(num)) return '';
            const sign = num < 0 ? '-' : '';
            return sign + Math.abs(num).toLocaleString('id-ID');
        }

        function handleThousandInput(el, callback) {
            const rawVal = el.value;
            const cursor = el.selectionStart;
            const oldLen = rawVal.length;
            const clean = rawVal.replace(/[^0-9]/g, '');

            if (!clean) {
                el.value = '';
            } else {
                const formatted = parseInt(clean, 10).toLocaleString('id-ID');
                el.value = formatted;
                const newLen = formatted.length;
                const newCursor = Math.max(0, cursor + (newLen - oldLen));
                try { el.setSelectionRange(newCursor, newCursor); } catch(e) {}
            }

            if (typeof callback === 'function') {
                callback();
            }
        }

        function handleSignedThousandInput(el, callback) {
            const rawVal = el.value;
            const cursor = el.selectionStart;
            const oldLen = rawVal.length;
            const isNegative = rawVal.trim().startsWith('-');
            const clean = rawVal.replace(/[^0-9]/g, '');

            if (!clean) {
                el.value = isNegative ? '-' : '';
            } else {
                const num = parseInt(clean, 10);
                const formatted = (isNegative ? '-' : '') + num.toLocaleString('id-ID');
                el.value = formatted;
                const newLen = formatted.length;
                const newCursor = Math.max(0, cursor + (newLen - oldLen));
                try { el.setSelectionRange(newCursor, newCursor); } catch(e) {}
            }

            if (typeof callback === 'function') {
                callback();
            }
        }

        /* ========================================================
           2. NAVIGASI UTAMA (SPA VIEW SWITCHER)
           ======================================================== */
        function setAppMode(viewName, subMode) {
            state.currentView = viewName;
            closeMobileSidebar();

            const views = ['dashboard', 'input', 'history', 'reminders', 'settings'];
            views.forEach(v => {
                const el = document.getElementById('view-' + v);
                if (el) {
                    if (v === viewName) {
                        el.classList.remove('hidden');
                        el.classList.add('spa-view-active');
                    } else {
                        el.classList.add('hidden');
                        el.classList.remove('spa-view-active');
                    }
                }

                const navBtn = document.getElementById('nav-' + v);
                if (navBtn) navBtn.classList.toggle('active', v === viewName);

                const bnavBtn = document.getElementById('bnav-' + v);
                if (bnavBtn) bnavBtn.classList.toggle('active', v === viewName);
            });

            // Sinkronisasi FAB input di bottom navigation
            const bnavFab = document.getElementById('bnav-input');
            if (bnavFab) bnavFab.classList.toggle('active', viewName === 'input');

            // Scroll ke atas dengan halus tanpa refresh
            try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch(e) {}

            const titles = {
                dashboard: "Dashboard",
                input: "Input Transaksi",
                history: "Riwayat Transaksi",
                reminders: "Pengingat",
                settings: "Pengaturan"
            };
            const topTitle = document.getElementById('topBarTitle');
            if (topTitle) topTitle.innerText = titles[viewName] || "Saturuma";

            if (viewName === 'dashboard') {
                renderDashboard();
            } else if (viewName === 'input') {
                if (subMode) switchInputSubMode(subMode);
            } else if (viewName === 'history') {
                filterHistoryList();
            } else if (viewName === 'reminders') {
                if (subMode) switchReminderSubMenu(subMode);
                renderReminders();
            } else if (viewName === 'settings') {
                renderSettingsCategories();
                renderUserProfile();
                updateThemeUI();
                updateCardBorderUI();
                if (subMode && (SETTINGS_ACCORDION_SECTIONS.includes(subMode) || SETTINGS_TABS.includes(subMode))) {
                    setTimeout(() => {
                        toggleSettingsAccordion(subMode);
                    }, 50);
                } else {
                    const lastTab = safeStorage.getItem('saturuma_active_settings_tab') || 'appearance';
                    switchSettingsTab(lastTab);
                }
            }
        }

        function toggleScanPanel(forceState) {
            const aiSec = document.getElementById('input-sub-ai');
            const btnText = document.getElementById('btnToggleScanText');
            const btnIcon = document.getElementById('btnToggleScanIcon');
            const btn = document.getElementById('btnToggleScanPanel');
            if (!aiSec) return;

            let shouldOpen;
            if (typeof forceState === 'boolean') {
                shouldOpen = forceState;
            } else {
                shouldOpen = aiSec.classList.contains('hidden');
            }

            if (shouldOpen) {
                aiSec.classList.remove('hidden');
                state.currentSubInputMode = 'ai';
                if (btnText) btnText.innerText = "Sembunyikan Pemindai";
                if (btnIcon) btnIcon.className = "fa-solid fa-chevron-up text-[10px] transition-transform duration-200";
                if (btn) {
                    btn.classList.add('bg-purple-600', 'text-white', 'border-purple-600');
                    btn.classList.remove('bg-purple-50', 'dark:bg-purple-950/40', 'text-purple-700', 'dark:text-purple-300', 'border-purple-300', 'dark:border-purple-800');
                }
                try { aiSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch(e) {}
            } else {
                aiSec.classList.add('hidden');
                state.currentSubInputMode = 'manual';
                if (btnText) btnText.innerText = "Pindai Struk AI & OCR";
                if (btnIcon) btnIcon.className = "fa-solid fa-chevron-down text-[10px] transition-transform duration-200";
                if (btn) {
                    btn.classList.remove('bg-purple-600', 'text-white', 'border-purple-600');
                    btn.classList.add('bg-purple-50', 'dark:bg-purple-950/40', 'text-purple-700', 'dark:text-purple-300', 'border-purple-300', 'dark:border-purple-800');
                }
            }
        }

        function switchInputSubMode(subMode) {
            toggleScanPanel(subMode === 'ai');
        }

        /* HERO ACTIONS INTEGRATION (DARI TEST_OCR.HTML) */
        function activateScanAction() {
            if (document.getElementById('editReceiptId')?.value.trim()) {
                resetTransactionForm();
            }
            setAppMode('input', 'ai');
            switchScannerMethod('full_ai');
            toggleScanPanel(true);
            setTimeout(() => {
                const scanner = document.getElementById('input-sub-ai');
                if (scanner) scanner.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 120);
        }

        function activateManualAction() {
            if (document.getElementById('editReceiptId')?.value.trim()) {
                resetTransactionForm();
            }
            setAppMode('input', 'manual');
            toggleScanPanel(false);
            setTimeout(() => {
                const mInp = document.getElementById('formMerchant');
                if (mInp) {
                    mInp.focus();
                    mInp.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 120);
        }

        function toggleScannerPresets(forceState) {
            const box = document.getElementById('scannerPresetsBox');
            const icon = document.getElementById('togglePresetsIcon');
            if (!box) return;

            let shouldOpen;
            if (typeof forceState === 'boolean') {
                shouldOpen = forceState;
            } else {
                shouldOpen = box.classList.contains('hidden');
            }

            if (shouldOpen) {
                box.classList.remove('hidden');
                if (icon) icon.className = "fa-solid fa-chevron-up text-[10px]";
                try { box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch(e) {}
            } else {
                box.classList.add('hidden');
                if (icon) icon.className = "fa-solid fa-chevron-down text-[10px]";
            }
        }

        function toggleScannerRawLog(forceState) {
            const box = document.getElementById('scannerRawLogBox');
            const icon = document.getElementById('toggleRawLogIcon');
            if (!box) return;

            let shouldOpen;
            if (typeof forceState === 'boolean') {
                shouldOpen = forceState;
            } else {
                shouldOpen = box.classList.contains('hidden');
            }

            if (shouldOpen) {
                box.classList.remove('hidden');
                if (icon) icon.className = "fa-solid fa-chevron-up text-[10px]";
                try { box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch(e) {}
            } else {
                box.classList.add('hidden');
                if (icon) icon.className = "fa-solid fa-chevron-down text-[10px]";
            }
        }

        function toggleMobileSidebar() {
            const sidebar = document.getElementById('appSidebar');
            const backdrop = document.getElementById('sidebarBackdrop');
            if (sidebar) {
                const isOpen = sidebar.classList.toggle('mobile-open');
                if (backdrop) {
                    if (isOpen) {
                        backdrop.classList.remove('hidden');
                        requestAnimationFrame(() => {
                            backdrop.classList.remove('opacity-0');
                            backdrop.classList.add('opacity-100');
                        });
                    } else {
                        backdrop.classList.remove('opacity-100');
                        backdrop.classList.add('opacity-0');
                        setTimeout(() => backdrop.classList.add('hidden'), 200);
                    }
                }
            }
        }

        function closeMobileSidebar() {
            const sidebar = document.getElementById('appSidebar');
            const backdrop = document.getElementById('sidebarBackdrop');
            if (sidebar && sidebar.classList.contains('mobile-open')) {
                sidebar.classList.remove('mobile-open');
            }
            if (backdrop) {
                backdrop.classList.remove('opacity-100');
                backdrop.classList.add('opacity-0');
                setTimeout(() => backdrop.classList.add('hidden'), 200);
            }
        }

        function handleHeroSectionClick(e) {
            const sidebar = document.getElementById('appSidebar');
            if (sidebar && sidebar.classList.contains('mobile-open')) {
                closeMobileSidebar();
                // Jika saat sidebar aktif pengguna mengeklik kontrol filter di hero section,
                // dahulukan menutup sidebar tanpa sengaja mengubah isi filter
                if (e && e.target && e.target.closest('select, button, input, a')) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        }

        /* ========================================================
           3. MASTER CATEGORY SWITCHER & SELECTION
           ======================================================== */
        function handleMasterCategorySwitch(catId) {
            state.activeMasterCategoryId = catId;

            // Perbarui warna aksen dinamis mengikuti Master Kategori yang dipilih
            if (catId === 'all') {
                const mc = getMultiModuleConfig();
                applyDynamicAccentColor(mc.color || '#10B981');
            } else {
                const cat = state.masterCategories.find(c => c.id === catId || c.sheetName === catId);
                if (cat && cat.color) {
                    applyDynamicAccentColor(cat.color);
                }
            }

            // Sinkronkan Select Header & Dropdown Hero Dashboard
            const headerSelect = document.getElementById('headerCategorySelect');
            if (headerSelect && headerSelect.value !== catId) {
                headerSelect.value = catId;
            }
            const heroSelect = document.getElementById('dashboardCategorySelect');
            if (heroSelect && heroSelect.value !== catId) {
                heroSelect.value = catId;
            }

            // Sinkronkan Form Destination Kategori jika bukan 'all'
            if (catId !== 'all') {
                const formSelect = document.getElementById('formMasterCategorySelect');
                if (formSelect) {
                    formSelect.value = catId;
                    handleFormCategoryChange(catId);
                }
            }

            renderCategoryPills();
            renderSidebarCategories();
            updateDashboardSubCategoryOptions();

            if (state.currentView === 'dashboard') {
                renderDashboard();
            } else if (state.currentView === 'history') {
                const histSelect = document.getElementById('historyCategoryFilter');
                if (histSelect) histSelect.value = catId;
                filterHistoryList();
            }
        }

        function renderCategoryPills() {
            // Sinkronkan dropdown pilihan modul di hero section dashboard
            const heroSelect = document.getElementById('dashboardCategorySelect');
            if (heroSelect) {
                heroSelect.value = state.activeMasterCategoryId || 'all';
            }

            // Render interactive pills in #dashboardQuickCategoryPills
            const pillsContainer = document.getElementById('dashboardQuickCategoryPills');
            if (!pillsContainer) return;

            const isAll = state.activeMasterCategoryId === 'all';
            const mc = getMultiModuleConfig();
            const mcColor = mc.color || '#10B981';
            const mcIcon = mc.icon || 'fa-layer-group';

            let pillsHtml = `
                <button type="button" onclick="handleMasterCategorySwitch('all')" 
                    class="px-2.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 hover:scale-102 ${isAll ? 'text-white' : 'bg-[var(--bg-surface)] text-[var(--text-muted)] border hover:border-[var(--primary)]'}"
                    style="${isAll ? `background-color: ${mcColor}; border-color: ${mcColor}; box-shadow: 0 4px 12px -2px ${hexToRgba(mcColor, 0.35)};` : `border-color: ${hexToRgba(mcColor, 0.35)}; border-left: 3.5px solid ${mcColor}; box-shadow: 0 2px 6px -1px ${hexToRgba(mcColor, 0.16)}; color: var(--text-main);`}">
                    <i class="fa-solid ${mcIcon} text-[11px]"></i>
                    <span>${escapeHtml(mc.name)}</span>
                </button>
            `;

            state.masterCategories.forEach(cat => {
                const isSel = state.activeMasterCategoryId === cat.id;
                const catColor = cat.color || '#10B981';
                const catIcon = cat.icon || 'fa-folder';

                pillsHtml += `
                    <button type="button" onclick="handleMasterCategorySwitch('${cat.id}')" 
                        class="px-2.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 shrink-0 hover:scale-102 ${isSel ? 'font-bold text-white' : 'bg-[var(--bg-surface)] border hover:border-[var(--primary)]'}"
                        style="${isSel ? `background-color: ${catColor}; border-color: ${catColor}; box-shadow: 0 4px 12px -2px ${hexToRgba(catColor, 0.35)};` : `border-color: ${hexToRgba(catColor, 0.35)}; border-left: 3.5px solid ${catColor}; box-shadow: 0 2px 6px -1px ${hexToRgba(catColor, 0.16)}; color: var(--text-main);`}">
                        <i class="fa-solid ${catIcon} text-[11px]" style="${isSel ? 'color: white;' : `color: ${catColor};`}"></i>
                        <span>${escapeHtml(cat.name)}</span>
                    </button>
                `;
            });

            pillsContainer.innerHTML = pillsHtml;
        }

        function handleDashboardSortChange(sortVal) {
            state.dashboardSort = sortVal;
            renderDashboard();
            showToast(`Urutan diubah ke: ${getSortLabel(sortVal)}`, "info", 1500);
        }

        function handleDashboardSearch(query) {
            state.dashboardSearch = (query || '').toLowerCase().trim();
            renderDashboard();
        }

        function getSortLabel(sortVal) {
            const map = {
                'date_desc': 'Tanggal Terbaru',
                'date_asc': 'Tanggal Terlama',
                'cost_desc': 'Nominal Terbesar',
                'cost_asc': 'Nominal Terkecil',
                'name_asc': 'Nama A - Z'
            };
            return map[sortVal] || sortVal;
        }

        function getPeriodLabel(period) {
            const map = {
                'today': 'Hari Ini',
                '7days': '7 Hari Terakhir',
                '30days': '30 Hari Terakhir',
                'lastMonth': 'Bulan Lalu',
                'year': 'Tahun Ini',
                'custom': 'Rentang Kustom',
                'all': 'Semua Waktu'
            };
            if (period === 'month') {
                const d = state.dashboardMonthDate || new Date();
                const now = new Date();
                const monthNames = [
                    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
                    "Juli", "Agustus", "September", "Oktober", "November", "Desember"
                ];
                if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
                    return `Bulan Ini (${monthNames[d.getMonth()]} ${d.getFullYear()})`;
                } else {
                    return `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
                }
            }
            return map[period] || 'Bulan Ini';
        }

        function filterByTopCategory() {
            const kpiTop = document.getElementById('kpiTopCategory');
            if (!kpiTop) return;
            const topVal = kpiTop.innerText.trim();
            if (!topVal || topVal === '-') return;

            const isAllModules = state.activeMasterCategoryId === 'all';
            const hasSubCat = state.dashboardSubCategory && state.dashboardSubCategory !== 'all';
            const hasMerchant = state.dashboardMerchant && state.dashboardMerchant !== 'all';

            // Jika masih di Semua Modul, cek apakah topVal adalah master category
            if (isAllModules) {
                const found = state.masterCategories.find(c => c.name.toLowerCase() === topVal.toLowerCase());
                if (found) {
                    handleMasterCategorySwitch(found.id);
                    showToast(`Memfilter modul: ${found.name}`);
                    return;
                }
            }

            // Jika modul sudah dipilih tapi sub-kategori belum
            if (!hasSubCat) {
                state.dashboardSubCategory = topVal;
                const subSel = document.getElementById('dashboardSubCategorySelect');
                if (subSel) {
                    subSel.value = topVal;
                    if (typeof refreshCustomDropdown === 'function') refreshCustomDropdown(subSel);
                }
                renderDashboard();
                showToast(`Memfilter sub-kategori: ${topVal}`);
                return;
            }

            // Jika sub-kategori sudah dipilih tapi merchant belum
            if (!hasMerchant) {
                state.dashboardMerchant = topVal;
                const merSel = document.getElementById('dashboardMerchantSelect');
                if (merSel) {
                    merSel.value = topVal;
                    if (typeof refreshCustomDropdown === 'function') refreshCustomDropdown(merSel);
                }
                renderDashboard();
                showToast(`Memfilter toko: ${topVal}`);
                return;
            }
        }

        function renderSidebarCategories() {
            const list = document.getElementById('sidebarCategoryList');
            if (!list) return;

            const isAll = state.activeMasterCategoryId === 'all';
            const mc = getMultiModuleConfig();
            const mcColor = mc.color || '#10B981';
            const mcIcon = mc.icon || 'fa-layer-group';

            let html = `
                <div onclick="handleMasterCategorySwitch('all')" class="flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all group ${isAll ? 'bg-[var(--primary-light)] font-bold' : 'text-[var(--text-muted)] hover:bg-[var(--border-color)]/30 hover:text-[var(--text-main)]'}" style="${isAll ? `color: ${mcColor};` : ''}">
                    <span class="flex items-center gap-2 truncate">
                        <span class="w-6 h-6 rounded-md flex items-center justify-center text-xs flex-shrink-0 transition-transform group-hover:scale-110" style="background-color: ${isAll ? mcColor : hexToRgba(mcColor, 0.15)}; color: ${isAll ? '#ffffff' : mcColor}; ${isAll ? 'box-shadow: 0 2px 6px ' + hexToRgba(mcColor, 0.3) : ''}">
                            <i class="fa-solid ${mcIcon}"></i>
                        </span>
                        <span class="truncate">${escapeHtml(mc.name)}</span>
                    </span>
                    <i class="fa-solid fa-chevron-right text-[9px] opacity-70 group-hover:translate-x-0.5 transition-transform"></i>
                </div>
            `;

            state.masterCategories.forEach(cat => {
                const isSel = state.activeMasterCategoryId === cat.id;
                const iconClass = cat.icon ? (cat.icon.includes('fa-') ? (cat.icon.startsWith('fa-') ? `fa-solid ${cat.icon}` : cat.icon) : `fa-solid fa-${cat.icon}`) : 'fa-solid fa-folder';
                const catColor = cat.color || '#10B981';

                html += `
                    <div onclick="handleMasterCategorySwitch('${cat.id}')" class="flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all group ${isSel ? 'bg-[var(--primary-light)] font-bold' : 'text-[var(--text-muted)] hover:bg-[var(--border-color)]/30 hover:text-[var(--text-main)]'}" style="${isSel ? `color: ${catColor};` : ''}">
                        <span class="flex items-center gap-2 truncate">
                            <span class="w-6 h-6 rounded-md flex items-center justify-center text-xs flex-shrink-0 transition-transform group-hover:scale-110" style="background-color: ${isSel ? catColor : hexToRgba(catColor, 0.15)}; color: ${isSel ? '#ffffff' : catColor}; ${isSel ? 'box-shadow: 0 2px 6px ' + hexToRgba(catColor, 0.3) : ''}">
                                <i class="${iconClass}"></i>
                            </span>
                            <span class="truncate">${escapeHtml(cat.name)}</span>
                        </span>
                        <i class="fa-solid fa-chevron-right text-[9px] opacity-70 group-hover:translate-x-0.5 transition-transform"></i>
                    </div>
                `;
            });

            list.innerHTML = html;
        }

        function updateCategoryDropdowns() {
            const dropdownIds = ['headerCategorySelect', 'dashboardCategorySelect', 'formMasterCategorySelect', 'historyCategoryFilter', 'remInputCategory', 'itemInputCategory', 'itemCatalogCategoryFilter'];
            dropdownIds.forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;

                const curVal = el.value || (id === 'dashboardCategorySelect' || id === 'headerCategorySelect' ? state.activeMasterCategoryId : '');
                let html = '';

                const mc = getMultiModuleConfig();
                if (id === 'formMasterCategorySelect') {
                    html += `<option value="all">🌟 ${escapeHtml(mc.name)}</option>`;
                } else if (id === 'headerCategorySelect' || id === 'dashboardCategorySelect' || id === 'historyCategoryFilter' || id === 'itemCatalogCategoryFilter') {
                    html += `<option value="all">${escapeHtml(mc.name)}</option>`;
                }

                state.masterCategories.forEach(cat => {
                    html += `<option value="${cat.id}">${escapeHtml(cat.name)}</option>`;
                });

                el.innerHTML = html;
                if (curVal && Array.from(el.options).some(o => o.value === curVal)) {
                    el.value = curVal;
                } else if (id === 'dashboardCategorySelect' || id === 'headerCategorySelect') {
                    el.value = state.activeMasterCategoryId || 'all';
                } else if (id === 'remInputCategory' || id === 'itemInputCategory') {
                    if (state.masterCategories && state.masterCategories.length > 0) {
                        el.value = state.masterCategories[0].id;
                    }
                }
                if (el.dataset.customDropdownReady === 'true' && typeof refreshCustomDropdown === 'function') {
                    refreshCustomDropdown(el);
                }
            });

            updateDashboardSubCategoryOptions();
            updateDashboardMerchantOptions();
            if (typeof enhanceAllCustomSelects === 'function') {
                enhanceAllCustomSelects();
            }
        }

        /* ========================================================
           4. DASHBOARD FIRST (KPI & CHART.JS ADVANCED INTEGRATION)
           ======================================================== */
        function formatRupiah(num) {
            return 'Rp ' + Number(num || 0).toLocaleString('id-ID');
        }

        function toggleDashboardAdvancedFilters() {
            const panel = document.getElementById('dashboardAdvancedFiltersPanel');
            const btn = document.getElementById('btnToggleAdvancedFilters');
            if (!panel) return;
            const isHidden = panel.classList.contains('hidden');
            if (isHidden) {
                panel.classList.remove('hidden');
                if (btn) {
                    btn.classList.add('bg-[var(--primary)]', 'text-white');
                    btn.classList.remove('btn-secondary');
                }
            } else {
                panel.classList.add('hidden');
                if (btn) {
                    btn.classList.remove('bg-[var(--primary)]', 'text-white');
                    btn.classList.add('btn-secondary');
                }
            }
        }

        function switchAnalyticsHubTab(tabName) {
            state.activeAnalyticsTab = tabName || 'trend';
            const tabs = [
                { id: 'trend', btn: 'atab-trend', pane: 'paneAnalyticsTrend' },
                { id: 'composition', btn: 'atab-composition', pane: 'paneAnalyticsComposition' },
                { id: 'budget_modules', btn: 'atab-budget-modules', pane: 'paneAnalyticsBudgetModules' }
            ];

            tabs.forEach(t => {
                const btn = document.getElementById(t.btn);
                const pane = document.getElementById(t.pane);
                if (t.id === state.activeAnalyticsTab) {
                    if (btn) {
                        btn.style.backgroundColor = "var(--primary)";
                        btn.classList.add('text-white');
                        btn.classList.remove('text-[var(--text-muted)]');
                    }
                    if (pane) pane.classList.remove('hidden');
                } else {
                    if (btn) {
                        btn.style.backgroundColor = "transparent";
                        btn.classList.remove('text-white');
                        btn.classList.add('text-[var(--text-muted)]');
                    }
                    if (pane) pane.classList.add('hidden');
                }
            });

            // Trigger chart update / resize when tab switches so canvas fits container
            setTimeout(() => {
                if (state.trendChartInstance) state.trendChartInstance.resize();
                if (state.monthlyCompareChartInstance) state.monthlyCompareChartInstance.resize();
                if (state.chartInstance) state.chartInstance.resize();
            }, 60);
        }

        function handleDashboardPeriodChange(val) {
            state.dashboardPeriod = val;
            const customRow = document.getElementById('dashboardCustomDateRow');
            if (customRow) {
                if (val === 'custom') {
                    customRow.classList.remove('hidden');
                } else {
                    customRow.classList.add('hidden');
                }
            }
            renderDashboard();
        }

        function handleDashboardCustomDateChange() {
            const startInp = document.getElementById('dashboardStartDate');
            const endInp = document.getElementById('dashboardEndDate');
            state.dashboardStartDate = startInp ? startInp.value : '';
            state.dashboardEndDate = endInp ? endInp.value : '';
            renderDashboard();
        }

        function changeDashboardMonth(delta) {
            if (!state.dashboardMonthDate) {
                state.dashboardMonthDate = new Date();
            }
            const d = new Date(state.dashboardMonthDate);
            d.setDate(1);
            d.setMonth(d.getMonth() + delta);
            state.dashboardMonthDate = d;
            state.dashboardPeriod = 'month';

            const periodSelect = document.getElementById('dashboardPeriodSelect');
            if (periodSelect) periodSelect.value = 'month';

            const customRow = document.getElementById('dashboardCustomDateRow');
            if (customRow) customRow.classList.add('hidden');

            updateDashboardMonthLabel();
            renderDashboard();
        }

        function goToDashboardCurrentMonth() {
            state.dashboardMonthDate = new Date();
            state.dashboardPeriod = 'month';

            const periodSelect = document.getElementById('dashboardPeriodSelect');
            if (periodSelect) periodSelect.value = 'month';

            const customRow = document.getElementById('dashboardCustomDateRow');
            if (customRow) customRow.classList.add('hidden');

            updateDashboardMonthLabel();
            renderDashboard();
        }

        function updateDashboardMonthLabel() {
            const monthLabel = document.getElementById('dashboardMonthLabel');
            if (!monthLabel) return;
            if (!state.dashboardMonthDate) {
                state.dashboardMonthDate = new Date();
            }
            const d = state.dashboardMonthDate;
            const monthNames = [
                "Januari", "Februari", "Maret", "April", "Mei", "Juni",
                "Juli", "Agustus", "September", "Oktober", "November", "Desember"
            ];
            monthLabel.textContent = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
        }

        /* ---------------- PEMILIH BULAN & TAHUN (POPOVER DROPDOWN) ---------------- */
        let pickerSelectedYear = new Date().getFullYear();

        function toggleDashboardMonthPicker(event) {
            if (event) {
                event.stopPropagation();
            }
            const popover = document.getElementById('dashboardMonthPickerPopover');
            if (!popover) return;
            const isHidden = popover.classList.contains('hidden');
            if (isHidden) {
                openDashboardMonthPicker();
            } else {
                closeDashboardMonthPicker();
            }
        }

        function openDashboardMonthPicker() {
            const popover = document.getElementById('dashboardMonthPickerPopover');
            if (!popover) return;
            if (!state.dashboardMonthDate) {
                state.dashboardMonthDate = new Date();
            }
            pickerSelectedYear = state.dashboardMonthDate.getFullYear();
            renderMonthPickerGrid();
            popover.classList.remove('hidden');

            setTimeout(() => {
                document.addEventListener('click', handleOutsideClickMonthPicker);
            }, 10);
        }

        function closeDashboardMonthPicker() {
            const popover = document.getElementById('dashboardMonthPickerPopover');
            if (popover) popover.classList.add('hidden');
            document.removeEventListener('click', handleOutsideClickMonthPicker);
        }

        function handleOutsideClickMonthPicker(e) {
            const popover = document.getElementById('dashboardMonthPickerPopover');
            const labelBtn = document.getElementById('dashboardMonthLabelBtn');
            if (popover && !popover.contains(e.target) && labelBtn && !labelBtn.contains(e.target)) {
                closeDashboardMonthPicker();
            }
        }

        function changeMonthPickerYear(delta) {
            pickerSelectedYear += delta;
            renderMonthPickerGrid();
        }

        function renderMonthPickerGrid() {
            const yearDisplay = document.getElementById('pickerYearDisplay');
            if (yearDisplay) yearDisplay.textContent = pickerSelectedYear;

            const grid = document.getElementById('pickerMonthGrid');
            if (!grid) return;

            const monthNamesShort = [
                "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
                "Jul", "Agu", "Sep", "Okt", "Nov", "Des"
            ];
            const fullMonthNames = [
                "Januari", "Februari", "Maret", "April", "Mei", "Juni",
                "Juli", "Agustus", "September", "Oktober", "November", "Desember"
            ];

            const currentD = state.dashboardMonthDate || new Date();
            const activeYear = currentD.getFullYear();
            const activeMonth = currentD.getMonth();
            const now = new Date();
            const thisYear = now.getFullYear();
            const thisMonth = now.getMonth();

            let html = '';
            monthNamesShort.forEach((mName, idx) => {
                const isCurrentActive = (pickerSelectedYear === activeYear && idx === activeMonth);
                const isRealThisMonth = (pickerSelectedYear === thisYear && idx === thisMonth);

                let btnClass = "py-2 px-1 rounded-xl text-center text-xs transition-all cursor-pointer select-none ";
                if (isCurrentActive) {
                    btnClass += "bg-[var(--primary)] text-white font-black shadow-xs ring-2 ring-[var(--primary)]/30";
                } else if (isRealThisMonth) {
                    btnClass += "bg-[var(--primary-light)]/40 text-[var(--primary)] border border-[var(--primary)]/30 font-bold hover:bg-[var(--primary)] hover:text-white";
                } else {
                    btnClass += "bg-[var(--bg-surface)] hover:bg-[var(--primary-light)]/20 text-[var(--text-main)] border border-[var(--border-color)]/70";
                }

                html += `
                    <button type="button" onclick="selectDashboardMonthAndYear(${idx}, ${pickerSelectedYear})" class="${btnClass}" title="${fullMonthNames[idx]} ${pickerSelectedYear}">
                        ${mName}
                    </button>
                `;
            });

            grid.innerHTML = html;
        }

        function selectDashboardMonthAndYear(monthIdx, year) {
            state.dashboardMonthDate = new Date(year, monthIdx, 1);
            state.dashboardPeriod = 'month';

            const periodSelect = document.getElementById('dashboardPeriodSelect');
            if (periodSelect) periodSelect.value = 'month';

            const customRow = document.getElementById('dashboardCustomDateRow');
            if (customRow) customRow.classList.add('hidden');

            updateDashboardMonthLabel();
            closeDashboardMonthPicker();
            renderDashboard();

            const fullMonthNames = [
                "Januari", "Februari", "Maret", "April", "Mei", "Juni",
                "Juli", "Agustus", "September", "Oktober", "November", "Desember"
            ];
            showToast(`Periode aktif: ${fullMonthNames[monthIdx]} ${year}`, "info", 1500);
        }

        function handleDashboardSubCategoryChange(val) {
            state.dashboardSubCategory = val;
            renderDashboard();
        }

        function handleDashboardMerchantChange(val) {
            state.dashboardMerchant = val;
            renderDashboard();
        }

        function resetDashboardFilters() {
            state.activeMasterCategoryId = 'all';
            state.dashboardPeriod = 'month';
            state.dashboardMonthDate = new Date();
            state.dashboardSubCategory = 'all';
            state.dashboardMerchant = 'all';
            state.dashboardStartDate = '';
            state.dashboardEndDate = '';

            const catSelect = document.getElementById('dashboardCategorySelect');
            if (catSelect) catSelect.value = 'all';

            const headerCat = document.getElementById('headerCategorySelect');
            if (headerCat) headerCat.value = 'all';

            const subCatSelect = document.getElementById('dashboardSubCategorySelect');
            if (subCatSelect) subCatSelect.value = 'all';

            const merchantSelect = document.getElementById('dashboardMerchantSelect');
            if (merchantSelect) merchantSelect.value = 'all';

            const periodSelect = document.getElementById('dashboardPeriodSelect');
            if (periodSelect) periodSelect.value = 'month';

            const customRow = document.getElementById('dashboardCustomDateRow');
            if (customRow) customRow.classList.add('hidden');

            const startInp = document.getElementById('dashboardStartDate');
            if (startInp) startInp.value = '';
            const endInp = document.getElementById('dashboardEndDate');
            if (endInp) endInp.value = '';

            state.dashboardSort = 'date_desc';
            state.dashboardSearch = '';
            const sortSelect = document.getElementById('dashboardSortSelect');
            if (sortSelect) sortSelect.value = 'date_desc';
            const searchInput = document.getElementById('dashboardSearchInput');
            if (searchInput) searchInput.value = '';

            const badgeFilterCount = document.getElementById('badgeActiveFilterCount');
            if (badgeFilterCount) badgeFilterCount.classList.add('hidden');

            const mc = getMultiModuleConfig();
            applyDynamicAccentColor(mc.color || '#10B981');
            updateDashboardSubCategoryOptions();
            updateDashboardMerchantOptions();
            renderCategoryPills();
            renderSidebarCategories();
            if (typeof enhanceAllCustomSelects === 'function') {
                enhanceAllCustomSelects();
            }
            renderDashboard();
            showToast("Filter dashboard berhasil direset ke default.", "info", 2000);
        }

        function updateDashboardSubCategoryOptions() {
            const el = document.getElementById('dashboardSubCategorySelect');
            if (!el) return;

            let subCats = [];
            if (state.activeMasterCategoryId && state.activeMasterCategoryId !== 'all') {
                const cat = state.masterCategories.find(c => c.id === state.activeMasterCategoryId || c.sheetName === state.activeMasterCategoryId);
                if (cat && Array.isArray(cat.subCategories) && cat.subCategories.length > 0) {
                    subCats = [...cat.subCategories];
                }
            }

            // Jika masih kosong (Semua Modul atau modul belum ada daftar sub), ambil dari entri transaksi
            if (subCats.length === 0) {
                const setSubs = new Set();
                state.entries.forEach(e => {
                    if (state.activeMasterCategoryId === 'all' || e.masterCategoryId === state.activeMasterCategoryId || e.masterSheetName === state.activeMasterCategoryId) {
                        if (e.subCategory && e.subCategory.trim()) setSubs.add(e.subCategory.trim());
                    }
                });
                subCats = Array.from(setSubs).sort();
            }

            const curVal = state.dashboardSubCategory || 'all';
            let html = '<option value="all">Semua Sub-Kategori</option>';
            subCats.forEach(s => {
                const sel = (curVal === s) ? 'selected' : '';
                html += `<option value="${escapeHtml(s)}" ${sel}>${escapeHtml(s)}</option>`;
            });

            el.innerHTML = html;
            if (curVal !== 'all' && !subCats.includes(curVal)) {
                state.dashboardSubCategory = 'all';
                el.value = 'all';
            }
            if (typeof refreshCustomDropdown === 'function') {
                refreshCustomDropdown(el);
            }
        }

        function updateDashboardMerchantOptions() {
            const el = document.getElementById('dashboardMerchantSelect');
            if (!el) return;

            const merchants = new Set();
            state.entries.forEach(e => {
                if (state.activeMasterCategoryId === 'all' || e.masterCategoryId === state.activeMasterCategoryId || e.masterSheetName === state.activeMasterCategoryId) {
                    if (e.merchant && e.merchant.trim()) {
                        merchants.add(e.merchant.trim());
                    }
                }
            });

            const sortedMerchants = Array.from(merchants).sort();
            const curVal = state.dashboardMerchant || 'all';

            let html = '<option value="all">Semua Toko</option>';
            sortedMerchants.forEach(m => {
                const sel = (curVal === m) ? 'selected' : '';
                html += `<option value="${escapeHtml(m)}" ${sel}>${escapeHtml(m)}</option>`;
            });

            el.innerHTML = html;
            if (curVal !== 'all' && !sortedMerchants.includes(curVal)) {
                state.dashboardMerchant = 'all';
                el.value = 'all';
            }
            if (typeof refreshCustomDropdown === 'function') {
                refreshCustomDropdown(el);
            }
        }

        function getFilteredEntries() {
            let list = [...state.entries];

            // 1. Filter Modul Kategori
            if (state.activeMasterCategoryId && state.activeMasterCategoryId !== 'all') {
                list = list.filter(e => e.masterCategoryId === state.activeMasterCategoryId || e.masterSheetName === state.activeMasterCategoryId);
            }

            // 2. Filter Sub-Kategori
            if (state.dashboardSubCategory && state.dashboardSubCategory !== 'all') {
                list = list.filter(e => (e.subCategory || '').trim() === state.dashboardSubCategory);
            }

            // 3. Filter Merchant / Toko
            if (state.dashboardMerchant && state.dashboardMerchant !== 'all') {
                list = list.filter(e => (e.merchant || '').trim() === state.dashboardMerchant);
            }

            // 4. Filter Periode
            const now = new Date();
            const targetMonth = state.dashboardMonthDate || now;
            const curY = targetMonth.getFullYear();
            const curM = String(targetMonth.getMonth() + 1).padStart(2, '0');
            const curYM = `${curY}-${curM}`;
            const todayStr = now.toISOString().split('T')[0];

            if (state.dashboardPeriod === 'today') {
                list = list.filter(e => e.date === todayStr);
            } else if (state.dashboardPeriod === '7days') {
                const sevenDaysAgo = new Date();
                sevenDaysAgo.setDate(now.getDate() - 7);
                const limitDate = sevenDaysAgo.toISOString().split('T')[0];
                list = list.filter(e => (e.date || '') >= limitDate);
            } else if (state.dashboardPeriod === '30days') {
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(now.getDate() - 30);
                const limitDate = thirtyDaysAgo.toISOString().split('T')[0];
                list = list.filter(e => (e.date || '') >= limitDate);
            } else if (state.dashboardPeriod === 'month') {
                list = list.filter(e => (e.date || '').substring(0, 7) === curYM);
            } else if (state.dashboardPeriod === 'lastMonth') {
                const lastMonthDate = new Date(curY, targetMonth.getMonth() - 1, 1);
                const lmYM = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
                list = list.filter(e => (e.date || '').substring(0, 7) === lmYM);
            } else if (state.dashboardPeriod === 'year') {
                list = list.filter(e => (e.date || '').substring(0, 4) === String(curY));
            } else if (state.dashboardPeriod === 'custom') {
                if (state.dashboardStartDate) {
                    list = list.filter(e => (e.date || '') >= state.dashboardStartDate);
                }
                if (state.dashboardEndDate) {
                    list = list.filter(e => (e.date || '') <= state.dashboardEndDate);
                }
            }

            // 5. Filter Search Kata Kunci Dashboard
            if (state.dashboardSearch) {
                const q = state.dashboardSearch;
                list = list.filter(e => 
                    (e.itemName || '').toLowerCase().includes(q) ||
                    (e.merchant || '').toLowerCase().includes(q) ||
                    (e.subCategory || '').toLowerCase().includes(q) ||
                    (e.masterCategoryName || '').toLowerCase().includes(q)
                );
            }

            // 6. Sorting / Pengurutan
            const sortMode = state.dashboardSort || 'date_desc';
            if (sortMode === 'cost_desc') {
                list.sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0));
            } else if (sortMode === 'cost_asc') {
                list.sort((a, b) => (Number(a.cost) || 0) - (Number(b.cost) || 0));
            } else if (sortMode === 'date_asc') {
                list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
            } else if (sortMode === 'name_asc') {
                list.sort((a, b) => (a.itemName || '').localeCompare(b.itemName || ''));
            } else {
                list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            }

            return list;
        }

        function getEntryNetCost(e) {
            const qty = Number(e.qty) || 1;
            const cost = Number(e.cost) || 0;
            const rawCost = cost * qty;
            const discount = Number(e.discount) || 0;
            const tax = Number(e.tax) || 0;
            const other = Number(e.other) || 0;
            return Math.max(0, rawCost - discount + tax + other);
        }

        function renderDashboard() {
            const filteredEntries = getFilteredEntries();

            // Kalkulasi Metrik KPI & Agregasi Dimensi (Menggunakan Nilai Riil Uang Keluar: Subtotal - Diskon + Pajak + Lainnya)
            let totalSpent = 0;
            let totalRawCost = 0;
            let totalDiscountSpent = 0;
            let totalTaxSpent = 0;
            let totalOtherSpent = 0;

            const categorySums = {};
            const subCategorySums = {};
            const merchantSums = {};
            const itemSums = {};
            const dailySums = {};

            filteredEntries.forEach(e => {
                const qty = Number(e.qty) || 1;
                const rawCost = (Number(e.cost) || 0) * qty;
                const discount = Number(e.discount) || 0;
                const tax = Number(e.tax) || 0;
                const other = Number(e.other) || 0;
                const netCost = Math.max(0, rawCost - discount + tax + other);

                totalRawCost += rawCost;
                totalDiscountSpent += discount;
                totalTaxSpent += tax;
                totalOtherSpent += other;
                totalSpent += netCost;

                const catName = e.masterCategoryName || "Lainnya";
                categorySums[catName] = (categorySums[catName] || 0) + netCost;

                const subCat = (e.subCategory && e.subCategory.trim()) ? e.subCategory.trim() : "Lainnya";
                subCategorySums[subCat] = (subCategorySums[subCat] || 0) + netCost;

                const merch = (e.merchant && e.merchant.trim()) ? e.merchant.trim() : "Lainnya";
                merchantSums[merch] = (merchantSums[merch] || 0) + netCost;

                const item = (e.itemName && e.itemName.trim()) ? e.itemName.trim() : "Lainnya";
                itemSums[item] = (itemSums[item] || 0) + netCost;

                if (e.date) {
                    dailySums[e.date] = (dailySums[e.date] || 0) + netCost;
                }
            });

            const isAllModules = state.activeMasterCategoryId === 'all';
            const activeCat = state.masterCategories.find(c => c.id === state.activeMasterCategoryId || c.sheetName === state.activeMasterCategoryId);
            const hasSubCatFilter = state.dashboardSubCategory && state.dashboardSubCategory !== 'all';
            const hasMerchantFilter = state.dashboardMerchant && state.dashboardMerchant !== 'all';

            // 1. Mini Stat 1: Total Pengeluaran Riil (Net Total)
            const kpiTotal = document.getElementById('kpiTotalSpent');
            if (kpiTotal) {
                kpiTotal.innerText = formatRupiah(totalSpent);
                if (totalDiscountSpent > 0 || totalTaxSpent > 0 || totalOtherSpent !== 0) {
                    kpiTotal.title = `Subtotal: ${formatRupiah(totalRawCost)} | Diskon: -${formatRupiah(totalDiscountSpent)} | Pajak: +${formatRupiah(totalTaxSpent)} | Lainnya: ${totalOtherSpent >= 0 ? '+' : ''}${formatRupiah(totalOtherSpent)}`;
                } else {
                    kpiTotal.title = `Total Pengeluaran Riil: ${formatRupiah(totalSpent)}`;
                }
            }

            const kpiCount = document.getElementById('kpiItemCount');
            if (kpiCount) {
                const uniqueReceipts = new Set(filteredEntries.map(e => e.receiptId)).size;
                kpiCount.innerText = `${filteredEntries.length} transaksi (${uniqueReceipts} struk)`;
                if (totalDiscountSpent > 0 || totalTaxSpent > 0 || totalOtherSpent !== 0) {
                    kpiCount.title = `Subtotal: ${formatRupiah(totalRawCost)} • Diskon: -${formatRupiah(totalDiscountSpent)} • Pajak: +${formatRupiah(totalTaxSpent)} • Lainnya: ${totalOtherSpent >= 0 ? '+' : ''}${formatRupiah(totalOtherSpent)}`;
                }
            }

            // 2. Mini Stat 2: Rata-rata Harian & Hari Ini
            const now = new Date();
            const targetMonth = state.dashboardMonthDate || now;
            const curY = targetMonth.getFullYear();
            const curM = targetMonth.getMonth();
            const isTargetCurrentMonth = (curY === now.getFullYear() && curM === now.getMonth());
            const daysInCurrentMonth = new Date(curY, curM + 1, 0).getDate();
            const todayStr = now.toISOString().split('T')[0];
            const todaySpent = dailySums[todayStr] || 0;

            updateDashboardMonthLabel();

            let effectiveDays = Math.max(Object.keys(dailySums).length, 1);
            if (state.dashboardPeriod === 'today') {
                effectiveDays = 1;
            } else if (state.dashboardPeriod === '7days') {
                effectiveDays = 7;
            } else if (state.dashboardPeriod === '30days') {
                effectiveDays = 30;
            } else if (state.dashboardPeriod === 'month') {
                effectiveDays = isTargetCurrentMonth ? Math.max(now.getDate(), 1) : daysInCurrentMonth;
            } else if (state.dashboardPeriod === 'lastMonth') {
                const prevMDate = new Date(curY, curM, 0);
                effectiveDays = prevMDate.getDate();
            } else if (state.dashboardPeriod === 'year') {
                const startOfYear = new Date(now.getFullYear(), 0, 1);
                effectiveDays = Math.max(Math.round((now - startOfYear) / (1000 * 60 * 60 * 24)) + 1, 1);
            } else if (state.dashboardPeriod === 'custom' && state.dashboardStartDate && state.dashboardEndDate) {
                const d1 = new Date(state.dashboardStartDate);
                const d2 = new Date(state.dashboardEndDate);
                effectiveDays = Math.max(Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1, 1);
            }

            const dailyAvg = Math.round(totalSpent / effectiveDays);
            const kpiDaily = document.getElementById('kpiDailyAvg');
            if (kpiDaily) kpiDaily.innerText = formatRupiah(dailyAvg);

            const kpiToday = document.getElementById('kpiTodaySpent');
            if (kpiToday) {
                const isTodayInRange = (state.dashboardPeriod === 'month' || state.dashboardPeriod === 'today' || state.dashboardPeriod === '7days' || state.dashboardPeriod === '30days' || state.dashboardPeriod === 'year' || state.dashboardPeriod === 'all' || (state.dashboardPeriod === 'custom' && (!state.dashboardEndDate || state.dashboardEndDate >= todayStr)));
                if (isTodayInRange) {
                    kpiToday.innerText = `Hari ini: ${formatRupiah(todaySpent)}`;
                } else {
                    const maxDaily = Object.values(dailySums).length > 0 ? Math.max(...Object.values(dailySums)) : 0;
                    kpiToday.innerText = `Tertinggi: ${formatRupiah(maxDaily)}`;
                }
            }

            // 3. Mini Stat 3: Alokasi Terbesar Mengikuti Hierarki Filter
            let topTargetSums = categorySums;
            let topTargetLabel = "Kategori Terbesar";

            if (hasSubCatFilter && hasMerchantFilter) {
                topTargetSums = itemSums;
                topTargetLabel = "Barang Terbesar";
            } else if (hasSubCatFilter) {
                topTargetSums = merchantSums;
                topTargetLabel = "Toko Terbesar";
            } else if (!isAllModules) {
                topTargetSums = subCategorySums;
                topTargetLabel = "Sub-Kategori Terbesar";
            } else {
                topTargetSums = categorySums;
                topTargetLabel = "Kategori Terbesar";
            }

            let topName = "-";
            let topCost = 0;
            Object.entries(topTargetSums).forEach(([c, val]) => {
                if (val > topCost) { topCost = val; topName = c; }
            });
            const topPct = totalSpent > 0 ? Math.round((topCost / totalSpent) * 100) : 0;

            const kpiTopLabel = document.getElementById('kpiTopCategoryLabel');
            if (kpiTopLabel) kpiTopLabel.textContent = topTargetLabel;

            const kpiTop = document.getElementById('kpiTopCategory');
            if (kpiTop) kpiTop.innerText = topName;

            const kpiTopAmt = document.getElementById('kpiTopCategoryAmount');
            if (kpiTopAmt) kpiTopAmt.innerText = topCost > 0 ? `${formatRupiah(topCost)} (${topPct}%)` : `Rp 0 (0%)`;

            // 4. Unified Financial Health Hero Card (Kondisi Keuangan & Anggaran)
            const baseMonthlyBudget = isAllModules 
                ? getTotalCategoryBudgets() 
                : (activeCat ? getCategoryBudget(activeCat.id) : getTotalCategoryBudgets());

            let budgetMultiplier = 1;
            let periodLabel = getPeriodLabel(state.dashboardPeriod);

            if (state.dashboardPeriod === 'today') {
                budgetMultiplier = 1 / daysInCurrentMonth;
            } else if (state.dashboardPeriod === '7days') {
                budgetMultiplier = 7 / daysInCurrentMonth;
            } else if (state.dashboardPeriod === '30days') {
                budgetMultiplier = 30 / daysInCurrentMonth;
            } else if (state.dashboardPeriod === 'month') {
                budgetMultiplier = 1;
            } else if (state.dashboardPeriod === 'lastMonth') {
                budgetMultiplier = 1;
            } else if (state.dashboardPeriod === 'year') {
                budgetMultiplier = 12;
            } else if (state.dashboardPeriod === 'custom') {
                if (state.dashboardStartDate && state.dashboardEndDate) {
                    const d1 = new Date(state.dashboardStartDate);
                    const d2 = new Date(state.dashboardEndDate);
                    const diffDays = Math.max(Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1, 1);
                    budgetMultiplier = diffDays / daysInCurrentMonth;
                    periodLabel = `${diffDays} Hari Terpilih`;
                }
            } else if (state.dashboardPeriod === 'all') {
                const distinctMonths = new Set(filteredEntries.map(e => (e.date || '').substring(0, 7)).filter(Boolean)).size;
                budgetMultiplier = Math.max(distinctMonths, 1);
            }

            const budget = Math.round(baseMonthlyBudget * budgetMultiplier);
            const pct = budget > 0 ? Math.round((totalSpent / budget) * 100) : (totalSpent > 0 ? 100 : 0);
            const remaining = Math.max(budget - totalSpent, 0);
            const isOver = budget > 0 && totalSpent > budget;
            const overAmount = isOver ? totalSpent - budget : 0;

            const targetLimitEl = document.getElementById('budgetSubTargetLimit');
            if (targetLimitEl) targetLimitEl.textContent = formatRupiah(budget);

            const realEl = document.getElementById('budgetSubRealization');
            if (realEl) realEl.textContent = formatRupiah(totalSpent);

            const remEl = document.getElementById('budgetSubRemaining');
            const remSuffixEl = document.getElementById('budgetSubRemainingSuffix');
            if (remEl) {
                if (isOver) {
                    remEl.textContent = formatRupiah(overAmount);
                    remEl.className = "text-2xl sm:text-3xl font-black text-rose-500 tracking-tight";
                    if (remSuffixEl) {
                        remSuffixEl.textContent = "melebihi target";
                        remSuffixEl.className = "text-xs text-rose-500 font-bold";
                    }
                } else {
                    remEl.textContent = formatRupiah(remaining);
                    remEl.className = "text-2xl sm:text-3xl font-black text-emerald-600 tracking-tight";
                    if (remSuffixEl) {
                        remSuffixEl.textContent = "tersisa";
                        remSuffixEl.className = "text-xs text-[var(--text-muted)] font-medium";
                    }
                }
            }

            const pctEl = document.getElementById('budgetSubPct');
            if (pctEl) pctEl.textContent = `${pct}% Terpakai`;

            let barColor = 'var(--primary)';
            let healthLabel = 'Aman';
            let badgeClass = 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20';

            if (pct >= 90) {
                barColor = '#ef4444';
                healthLabel = isOver ? 'Overbudget' : 'Kritis';
                badgeClass = 'bg-rose-500/10 text-rose-600 border border-rose-500/20';
            } else if (pct >= 70) {
                barColor = '#f59e0b';
                healthLabel = 'Waspada';
                badgeClass = 'bg-amber-500/10 text-amber-600 border border-amber-500/20';
            }

            const bar = document.getElementById('budgetSubProgressBar');
            if (bar) {
                bar.style.width = Math.min(pct, 100) + '%';
                bar.style.backgroundColor = barColor;
            }

            const healthBadge = document.getElementById('budgetSubHealthBadge');
            if (healthBadge) {
                healthBadge.className = `text-xs font-bold px-2.5 py-0.5 rounded-full ${badgeClass}`;
                healthBadge.textContent = `Status: ${healthLabel}`;
            }

            const heroPeriodLabel = document.getElementById('heroBudgetPeriodLabel');
            if (heroPeriodLabel) {
                const scopeName = isAllModules ? 'Belanja' : activeCat.name;
                heroPeriodLabel.textContent = `Sisa Kuota ${scopeName} (${periodLabel})`;
            }

            const activeFilterBadge = document.getElementById('heroActiveFilterBadge');
            if (activeFilterBadge) {
                const filterTags = [];
                if (!isAllModules && activeCat) filterTags.push(activeCat.name);
                if (hasSubCatFilter) filterTags.push(state.dashboardSubCategory);
                if (hasMerchantFilter) filterTags.push(state.dashboardMerchant);
                if (state.dashboardSearch) filterTags.push(`"${state.dashboardSearch}"`);
                
                if (filterTags.length > 0) {
                    activeFilterBadge.textContent = `Filter: ${filterTags.join(' • ')}`;
                    activeFilterBadge.classList.remove('hidden');
                } else {
                    activeFilterBadge.classList.add('hidden');
                }
            }

            const heroDailyPaceEl = document.getElementById('heroDailyPaceText');
            if (heroDailyPaceEl) {
                if (state.dashboardPeriod === 'month') {
                    const currentDay = now.getDate();
                    const daysRemaining = Math.max(daysInCurrentMonth - currentDay, 1);
                    const dailySafe = Math.round(remaining / daysRemaining);

                    if (isOver) {
                        heroDailyPaceEl.innerHTML = `<span class="text-rose-500 font-bold">⚠️ Target anggaran terlampaui.</span> Tahan pengeluaran untuk ${daysRemaining} hari sisa bulan ini.`;
                    } else if (pct >= 85) {
                        heroDailyPaceEl.innerHTML = `Batas belanja aman: <b class="text-amber-500 font-bold">${formatRupiah(dailySafe)}/hari</b> untuk ${daysRemaining} hari tersisa bulan ini.`;
                    } else {
                        heroDailyPaceEl.innerHTML = `Batas belanja aman: <b class="text-emerald-600 font-bold">${formatRupiah(dailySafe)}/hari</b> untuk ${daysRemaining} hari tersisa bulan ini.`;
                    }
                } else {
                    const distinctDaysCount = Math.max(Object.keys(dailySums).length, 1);
                    const avgPace = Math.round(totalSpent / distinctDaysCount);
                    heroDailyPaceEl.innerHTML = `Laju belanja: <b class="text-[var(--primary)] font-bold">${formatRupiah(avgPace)}/hari</b> sepanjang periode ${periodLabel.toLowerCase()} (${distinctDaysCount} hari aktif).`;
                }
            }

            // 5. Hitung badge filter aktif di toolbar
            const badgeFilterCount = document.getElementById('badgeActiveFilterCount');
            if (badgeFilterCount) {
                let count = 0;
                if (!isAllModules) count++;
                if (hasSubCatFilter) count++;
                if (hasMerchantFilter) count++;
                if (state.dashboardPeriod !== 'month') count++;
                if (state.dashboardSort && state.dashboardSort !== 'date_desc') count++;
                if (state.dashboardSearch && state.dashboardSearch.trim()) count++;

                if (count > 0) {
                    badgeFilterCount.textContent = count;
                    badgeFilterCount.classList.remove('hidden');
                } else {
                    badgeFilterCount.classList.add('hidden');
                }
            }

            // 6. Smart Narrative Insight
            const insightEl = document.getElementById('dashboardInsightText');
            if (insightEl) {
                if (filteredEntries.length === 0) {
                    insightEl.innerHTML = `Belum ada transaksi tercatat pada filter ini. Klik <b>Scan Struk</b> atau <b>Input</b> untuk mulai mencatat.`;
                } else if (isOver) {
                    insightEl.innerHTML = `⚠️ <b>Perhatian:</b> Total belanja telah melampaui pagu target sebesar <b>${formatRupiah(overAmount)}</b>. Alokasi terbesar: <b>${escapeHtml(topName)}</b> (${topPct}%). Disarankan meninjau pengeluaran non-esensial.`;
                } else if (pct >= 80) {
                    insightEl.innerHTML = `⚡ <b>Mendekati Batas:</b> Anda telah menyerap <b>${pct}%</b> dari pagu target (${formatRupiah(budget)}). Alokasi terbesar pada <b>${escapeHtml(topName)}</b> (${topPct}%). Jaga laju belanja harian agar kuota cukup.`;
                } else if (topPct >= 40 && topName !== '-') {
                    insightEl.innerHTML = `💡 <b>Dominasi Belanja:</b> Alokasi terbanyak ada pada <b>${escapeHtml(topName)}</b> (${topPct}% dari total). Rata-rata belanja: <b>${formatRupiah(dailyAvg)}/hari</b>.`;
                } else {
                    insightEl.innerHTML = `✨ <b>Keuangan Terkendali:</b> Penyerapan anggaran berjalan aman dan stabil di angka <b>${pct}%</b> dengan sisa kuota <b>${formatRupiah(remaining)}</b> (${periodLabel}).`;
                }
            }

            // 7. Visual Hub: Tren Harian & Perbandingan 5 Bulan Terakhir Mengikuti Filter
            renderTrendChart(dailySums, totalSpent, periodLabel);
            renderMonthlyComparisonChart();

            // 8. Visual Hub: Hitung agregasi seluruh master kategori & sub-kategori pada periode/bulan aktif (independen dari filter modul aktif)
            const periodCategorySums = {};
            const periodCategoryCounts = {};
            const periodSubCategorySums = {};
            const periodSubCategoryCounts = {};
            let periodTotalSpent = 0;

            const tDate = state.dashboardMonthDate || now;
            const targetY = tDate.getFullYear();
            const targetM = String(tDate.getMonth() + 1).padStart(2, '0');
            const targetYM = `${targetY}-${targetM}`;

            (state.entries || []).forEach(e => {
                // Filter Waktu Periode
                if (state.dashboardPeriod === 'today') {
                    if (e.date !== todayStr) return;
                } else if (state.dashboardPeriod === '7days') {
                    const sevenDaysAgo = new Date();
                    sevenDaysAgo.setDate(now.getDate() - 7);
                    if ((e.date || '') < sevenDaysAgo.toISOString().split('T')[0]) return;
                } else if (state.dashboardPeriod === '30days') {
                    const thirtyDaysAgo = new Date();
                    thirtyDaysAgo.setDate(now.getDate() - 30);
                    if ((e.date || '') < thirtyDaysAgo.toISOString().split('T')[0]) return;
                } else if (state.dashboardPeriod === 'month') {
                    if ((e.date || '').substring(0, 7) !== targetYM) return;
                } else if (state.dashboardPeriod === 'lastMonth') {
                    const lastMonthDate = new Date(targetY, tDate.getMonth() - 1, 1);
                    const lmYM = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
                    if ((e.date || '').substring(0, 7) !== lmYM) return;
                } else if (state.dashboardPeriod === 'year') {
                    if ((e.date || '').substring(0, 4) !== String(targetY)) return;
                } else if (state.dashboardPeriod === 'custom') {
                    if (state.dashboardStartDate && (e.date || '') < state.dashboardStartDate) return;
                    if (state.dashboardEndDate && (e.date || '') > state.dashboardEndDate) return;
                }

                // Filter Pencarian
                if (state.dashboardSearch) {
                    const q = state.dashboardSearch.toLowerCase();
                    const match = (e.itemName || '').toLowerCase().includes(q) ||
                        (e.merchant || '').toLowerCase().includes(q) ||
                        (e.subCategory || '').toLowerCase().includes(q) ||
                        (e.masterCategoryName || '').toLowerCase().includes(q);
                    if (!match) return;
                }

                const net = getEntryNetCost(e);
                periodTotalSpent += net;

                const matchedCat = (state.masterCategories || []).find(c => 
                    c.id === e.masterCategoryId || 
                    c.sheetName === e.masterSheetName || 
                    c.name === e.masterCategoryName
                );
                const cId = matchedCat ? matchedCat.id : (e.masterCategoryId || 'other');
                periodCategorySums[cId] = (periodCategorySums[cId] || 0) + net;
                periodCategoryCounts[cId] = (periodCategoryCounts[cId] || 0) + 1;

                if (!periodSubCategorySums[cId]) {
                    periodSubCategorySums[cId] = {};
                    periodSubCategoryCounts[cId] = {};
                }
                const subCat = (e.subCategory && e.subCategory.trim()) ? e.subCategory.trim() : 'Lainnya';
                periodSubCategorySums[cId][subCat] = (periodSubCategorySums[cId][subCat] || 0) + net;
                periodSubCategoryCounts[cId][subCat] = (periodSubCategoryCounts[cId][subCat] || 0) + 1;
            });

            // 8. Visual Hub: Komposisi Pengeluaran & Rincian Per Kategori
            renderAnalyticsChart(periodCategorySums, periodCategoryCounts, periodTotalSpent, periodSubCategorySums, periodSubCategoryCounts);

            // 9. Transaksi Terbaru Mengikuti Filter
            renderDashboardRecentReceipts();

            // 10. Sinkronkan angka target anggaran settings
            renderBudgetSubMenu();
        }

        function renderCategoryBreakdownList(periodCategorySums, periodCategoryCounts, periodTotalSpent, periodSubCategorySums, periodSubCategoryCounts) {
            const container = document.getElementById('categoryBreakdownList');
            if (!container) return;

            const titleEl = document.getElementById('categoryBreakdownTitle');
            const subtitleEl = document.getElementById('categoryBreakdownSubtitle');
            const badgeEl = document.getElementById('badgeActiveCategoryFilter');
            const isAll = (state.activeMasterCategoryId === 'all');
            const activeCat = (state.masterCategories || []).find(c => c.id === state.activeMasterCategoryId || c.sheetName === state.activeMasterCategoryId);

            const SUB_PALETTE = [
                '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
                '#06B6D4', '#EC4899', '#84CC16', '#F97316', '#6366F1',
                '#14B8A6', '#A855F7', '#E11D48', '#0EA5E9', '#D97706'
            ];

            if (isAll || !activeCat) {
                // Mode 1: Tampilkan Semua Master Kategori
                if (titleEl) {
                    titleEl.innerHTML = `<span class="flex items-center gap-1.5"><i class="fa-solid fa-shapes text-[var(--primary)]"></i> Rincian Per Kategori</span>`;
                }
                if (subtitleEl) {
                    subtitleEl.textContent = "(Klik kartu kategori untuk perbandingan sub-kategori)";
                }
                if (badgeEl) {
                    badgeEl.innerHTML = `<i class="fa-solid fa-layer-group text-[9px] mr-1"></i><span>Semua Modul</span>`;
                    badgeEl.className = "text-[10px] font-bold px-2.5 py-1 rounded-full bg-[var(--primary-light)] text-[var(--primary)] border border-[var(--primary)]/20 cursor-default shadow-2xs";
                    badgeEl.title = "Semua modul ditampilkan";
                }

                const cats = [...(state.masterCategories || [])];
                cats.sort((a, b) => {
                    const spentA = (periodCategorySums && periodCategorySums[a.id]) || 0;
                    const spentB = (periodCategorySums && periodCategorySums[b.id]) || 0;
                    return spentB - spentA;
                });

                if (cats.length === 0) {
                    container.innerHTML = `<div class="col-span-full p-4 text-center text-xs text-[var(--text-muted)]">Belum ada master kategori aktif.</div>`;
                    return;
                }

                let html = '';
                cats.forEach(cat => {
                    const val = (periodCategorySums && periodCategorySums[cat.id]) || 0;
                    const count = (periodCategoryCounts && periodCategoryCounts[cat.id]) || 0;
                    const pct = (periodTotalSpent > 0 && val > 0) ? Math.round((val / periodTotalSpent) * 100) : 0;
                    const catColor = cat.color || '#10B981';
                    const catIcon = cat.icon || 'fa-folder';
                    const catBudget = (typeof getCategoryBudget === 'function') ? getCategoryBudget(cat.id) : 0;
                    const isOverBudget = (catBudget > 0 && val > catBudget);
                    const absorbPct = (catBudget > 0) ? Math.round((val / catBudget) * 100) : 0;

                    html += `
                        <div onclick="handleCategoryBreakdownClick('${cat.id}')" role="button" tabindex="0" 
                             title="Klik untuk melihat perbandingan sub-kategori ${escapeHtml(cat.name)}"
                             class="p-2.5 rounded-xl border border-[var(--border-color)] bg-[var(--bg-surface)] hover:border-[var(--primary)] hover:bg-[var(--primary-light)]/5 cursor-pointer flex flex-col justify-between gap-1.5 transition-all duration-150 hover:scale-[1.01] hover:shadow-xs relative select-none group">
                            
                            <div class="flex items-center justify-between gap-1.5 min-w-0">
                                <div class="flex items-center gap-1.5 min-w-0">
                                    <span class="w-6 h-6 rounded-md flex items-center justify-center text-[10px] flex-shrink-0 shadow-2xs font-bold transition-transform group-hover:scale-105" 
                                          style="background-color: ${hexToRgba(catColor, 0.15)}; color: ${catColor};">
                                        <i class="fa-solid ${catIcon}"></i>
                                    </span>
                                    <div class="min-w-0 flex items-baseline gap-1">
                                        <span class="text-xs font-bold text-[var(--text-main)] truncate group-hover:text-[var(--primary)] transition-colors leading-none">${escapeHtml(cat.name)}</span>
                                        <span class="text-[9.5px] text-[var(--text-muted)] font-normal shrink-0 leading-none" title="${count} transaksi">(${count})</span>
                                    </div>
                                </div>
                                <div class="flex items-center gap-1 flex-shrink-0">
                                    <span class="text-[10px] font-bold text-[var(--text-muted)] leading-none" title="${pct}% dari total pengeluaran">${pct}%</span>
                                    <i class="fa-solid fa-chevron-right text-[8.5px] text-[var(--text-muted)]/60 group-hover:text-[var(--primary)] transition-transform group-hover:translate-x-0.5"></i>
                                </div>
                            </div>

                            <div class="space-y-1 pt-1 border-t border-[var(--border-color)]/40">
                                <div class="flex items-baseline justify-between text-xs leading-none">
                                    <span class="font-extrabold text-[var(--text-main)] text-[11px] sm:text-xs">${formatRupiah(val)}</span>
                                    <span class="text-[9.5px] ${isOverBudget ? 'text-rose-500 font-bold' : 'text-[var(--text-muted)]'} truncate ml-1 text-right" title="Target Anggaran: ${catBudget > 0 ? formatRupiah(catBudget) : '-'}">
                                        ${catBudget > 0 ? '<span class="text-[9px] opacity-70">Target:</span> ' + formatRupiah(catBudget) : '<span class="text-[9px] opacity-70">Target:</span> -'}
                                    </span>
                                </div>
                                <div class="w-full bg-[var(--border-color)]/60 h-1 rounded-full overflow-hidden">
                                    <div class="h-full rounded-full transition-all duration-300" style="width: ${catBudget > 0 ? Math.min(absorbPct, 100) : pct}%; background-color: ${isOverBudget ? '#ef4444' : catColor};"></div>
                                </div>
                            </div>
                        </div>
                    `;
                });

                container.innerHTML = html;
            } else {
                // Mode 2: Drilldown Perbandingan Sub-Kategori untuk Master Kategori Aktif
                const catSpent = (periodCategorySums && periodCategorySums[activeCat.id]) || 0;
                const catCount = (periodCategoryCounts && periodCategoryCounts[activeCat.id]) || 0;
                const catSubSums = (periodSubCategorySums && periodSubCategorySums[activeCat.id]) || {};
                const catSubCounts = (periodSubCategoryCounts && periodSubCategoryCounts[activeCat.id]) || {};
                const catBudget = (typeof getCategoryBudget === 'function') ? getCategoryBudget(activeCat.id) : 0;

                if (titleEl) {
                    titleEl.innerHTML = `<span class="flex items-center gap-1.5"><i class="fa-solid fa-layer-group text-[var(--primary)]"></i> Perbandingan Sub-Kategori: <b class="text-[var(--text-main)]">${escapeHtml(activeCat.name)}</b></span>`;
                }
                if (subtitleEl) {
                    subtitleEl.innerHTML = `Realisasi: <b>${formatRupiah(catSpent)}</b> | Target: <b>${catBudget > 0 ? formatRupiah(catBudget) : '-'}</b> (${catCount} transaksi)`;
                }
                if (badgeEl) {
                    badgeEl.innerHTML = `<i class="fa-solid fa-arrow-left text-[9px] mr-1"></i><span>Kembali ke Semua</span>`;
                    badgeEl.className = "text-[10px] font-bold px-2.5 py-1 rounded-full bg-[var(--primary)] text-white hover:bg-[var(--primary)]/90 cursor-pointer shadow-xs transition hover:scale-105 flex items-center";
                    badgeEl.title = "Klik untuk kembali ke semua master kategori";
                }

                // Himpun semua sub-kategori milik master kategori ini
                const subCatSet = new Set();
                if (Array.isArray(activeCat.subCategories)) {
                    activeCat.subCategories.forEach(s => {
                        if (s && s.trim()) subCatSet.add(s.trim());
                    });
                }
                Object.keys(catSubSums).forEach(s => {
                    if (s && s.trim()) subCatSet.add(s.trim());
                });
                if (subCatSet.size === 0) {
                    subCatSet.add("Umum");
                }

                const subList = Array.from(subCatSet).map(s => {
                    const val = catSubSums[s] || 0;
                    const count = catSubCounts[s] || 0;
                    const pct = (catSpent > 0 && val > 0) ? Math.round((val / catSpent) * 100) : 0;
                    return { name: s, val, count, pct };
                });

                // Urutkan: pengeluaran terbesar di atas, jika 0 urutkan alfabetis
                subList.sort((a, b) => {
                    if (b.val !== a.val) return b.val - a.val;
                    return a.name.localeCompare(b.name);
                });

                let html = '';
                subList.forEach((sub, idx) => {
                    const subColor = SUB_PALETTE[idx % SUB_PALETTE.length];
                    const isSelected = (state.dashboardSubCategory === sub.name);
                    const subBudgetPct = (catBudget > 0 && sub.val > 0) ? Math.round((sub.val / catBudget) * 100) : 0;

                    const cardBorder = isSelected 
                        ? `border-2 border-[var(--primary)] shadow-md ring-2 ring-[var(--primary)]/30` 
                        : `border border-[var(--border-color)] hover:border-[var(--primary)] hover:shadow-xs`;
                    const cardBg = isSelected 
                        ? `bg-[var(--primary-light)]/20` 
                        : `bg-[var(--bg-surface)] hover:bg-[var(--primary-light)]/5`;

                    html += `
                        <div data-sub="${escapeHtml(sub.name)}" data-cat="${activeCat ? activeCat.id : ''}" onclick="viewSubCategoryInHistory(this.dataset.sub, this.dataset.cat)" role="button" tabindex="0" 
                             title="Klik untuk membuka riwayat transaksi sub-kategori ${escapeHtml(sub.name)}"
                             class="p-2.5 rounded-xl ${cardBorder} ${cardBg} cursor-pointer flex flex-col justify-between gap-1.5 transition-all duration-150 hover:scale-[1.01] hover:shadow-xs relative select-none group">
                            
                            <div class="flex items-center justify-between gap-1.5 min-w-0">
                                <div class="flex items-center gap-1.5 min-w-0">
                                    <span class="w-6 h-6 rounded-md flex items-center justify-center text-[10px] flex-shrink-0 shadow-2xs font-bold transition-transform group-hover:scale-105" 
                                          style="background-color: ${hexToRgba(subColor, 0.15)}; color: ${subColor};">
                                        <i class="fa-solid fa-tags"></i>
                                    </span>
                                    <div class="min-w-0 flex items-baseline gap-1">
                                        <span class="text-xs font-bold text-[var(--text-main)] truncate group-hover:text-[var(--primary)] transition-colors leading-none">${escapeHtml(sub.name)}</span>
                                        <span class="text-[9.5px] text-[var(--text-muted)] font-normal shrink-0 leading-none" title="${sub.count} transaksi">(${sub.count})</span>
                                    </div>
                                </div>
                                <div class="flex items-center gap-1 flex-shrink-0">
                                    <span class="text-[10px] font-bold text-[var(--text-muted)] leading-none" title="${sub.pct}% dari total pengeluaran modul">${sub.pct}%</span>
                                    <span class="text-[9px] text-[var(--primary)] group-hover:translate-x-0.5 transition-transform" title="Buka di Riwayat">
                                        <i class="fa-solid fa-arrow-up-right-from-square"></i>
                                    </span>
                                </div>
                            </div>

                            <div class="space-y-1 pt-1 border-t border-[var(--border-color)]/40">
                                <div class="flex items-baseline justify-between text-xs leading-none">
                                    <span class="font-extrabold text-[var(--text-main)] text-[11px] sm:text-xs">${formatRupiah(sub.val)}</span>
                                    <span class="text-[9.5px] text-[var(--text-muted)] truncate ml-1 text-right" title="${catBudget > 0 ? 'Porsi Pagu Modul' : 'Porsi Kategori'}">
                                        <span class="text-[9px] opacity-70">${catBudget > 0 ? 'Porsi Pagu:' : 'Porsi:'}</span> ${catBudget > 0 ? subBudgetPct + '%' : sub.pct + '%'}
                                    </span>
                                </div>
                                <div class="w-full bg-[var(--border-color)]/60 h-1 rounded-full overflow-hidden">
                                    <div class="h-full rounded-full transition-all duration-300" style="width: ${sub.pct}%; background-color: ${subColor};"></div>
                                </div>
                            </div>
                        </div>
                    `;
                });

                container.innerHTML = html;
            }
        }

        function handleCategoryBreakdownClick(catId) {
            state.dashboardSubCategory = 'all';
            if (catId === 'all' || state.activeMasterCategoryId === catId) {
                handleMasterCategorySwitch('all');
                showToast("Menampilkan semua modul kategori", "info", 1500);
            } else {
                handleMasterCategorySwitch(catId);
                const cat = (state.masterCategories || []).find(c => c.id === catId || c.sheetName === catId);
                showToast(`Membuka perbandingan sub-kategori: ${cat ? cat.name : catId}`, "info", 1500);
            }
        }

        function selectDashboardSubCategoryFromBreakdown(subCatName) {
            const activeCatId = (state.activeMasterCategoryId && state.activeMasterCategoryId !== 'all') ? state.activeMasterCategoryId : '';
            viewSubCategoryInHistory(subCatName, activeCatId);
        }

        function viewSubCategoryInHistory(subCatName, catId) {
            if (!subCatName) return;

            // 1. Pindah tampilan ke Riwayat Transaksi
            setAppMode('history');

            // 2. Set filter kategori jika ada
            const catFilter = document.getElementById('historyCategoryFilter');
            if (catFilter && catId) {
                catFilter.value = catId;
            }

            // 3. Masukkan nama sub-kategori ke input pencarian riwayat
            const searchInp = document.getElementById('historySearchInput');
            if (searchInp) {
                searchInp.value = subCatName;
            }

            // 4. Pastikan periode waktu di riwayat menampilkan data
            const periodFilter = document.getElementById('historyPeriodFilter');
            if (periodFilter) {
                const now = new Date();
                const dDate = state.dashboardMonthDate || now;
                const isCurrentMonth = (dDate.getFullYear() === now.getFullYear() && dDate.getMonth() === now.getMonth());
                if (state.dashboardPeriod === 'month' && isCurrentMonth) {
                    periodFilter.value = 'thisMonth';
                } else {
                    periodFilter.value = 'all';
                }
                if (typeof handleHistoryPeriodChange === 'function') {
                    handleHistoryPeriodChange(periodFilter.value);
                } else {
                    filterHistoryList();
                }
            } else {
                filterHistoryList();
            }

            // 5. Scroll ke atas agar hasil filter langsung terlihat
            window.scrollTo({ top: 0, behavior: 'smooth' });

            showToast(`Menampilkan riwayat untuk sub-kategori: ${subCatName}`, "info", 1800);
        }

        function selectDashboardMerchantFromBreakdown(merchantName) {
            if (state.dashboardMerchant === merchantName) {
                state.dashboardMerchant = 'all';
                showToast("Menghapus filter toko", "info", 1500);
            } else {
                state.dashboardMerchant = merchantName;
                showToast(`Memfilter toko: ${merchantName}`, "info", 1500);
            }
            const sel = document.getElementById('dashboardMerchantSelect');
            if (sel) {
                sel.value = state.dashboardMerchant;
                if (typeof refreshCustomDropdown === 'function') refreshCustomDropdown(sel);
            }
            renderDashboard();
        }

        function switchChartType(type) {
            state.currentChartType = (type === 'line') ? 'doughnut' : type;
            const buttons = ['doughnut', 'pie', 'bar'];
            buttons.forEach(b => {
                const btn = document.getElementById('cbtn-' + b);
                if (btn) {
                    if (b === state.currentChartType) {
                        btn.style.backgroundColor = "var(--primary)";
                        btn.classList.add('text-white');
                        btn.classList.remove('text-[var(--text-muted)]');
                    } else {
                        btn.style.backgroundColor = "transparent";
                        btn.classList.remove('text-white');
                        btn.classList.add('text-[var(--text-muted)]');
                    }
                }
            });
            renderDashboard();
        }

        /* ---------------- TREN PENGELUARAN (MENGIKUTI FILTER) ---------------- */
        function renderTrendChart(dailySums, totalSpent, periodLabel) {
            const ctx = document.getElementById('trendAnalyticsChart');
            if (!ctx) return;

            if (state.trendChartInstance) {
                state.trendChartInstance.destroy();
            }

            const activeCat = state.masterCategories.find(c => c.id === state.activeMasterCategoryId || c.sheetName === state.activeMasterCategoryId);
            const titleEl = document.getElementById('trendChartTitle');
            const subTitleEl = document.getElementById('trendChartSubtitle');
            const badgeEl = document.getElementById('trendTotalBadge');

            if (titleEl) {
                const parts = [];
                if (state.activeMasterCategoryId !== 'all' && activeCat) {
                    parts.push(activeCat.name);
                }
                if (state.dashboardSubCategory && state.dashboardSubCategory !== 'all') {
                    parts.push(state.dashboardSubCategory);
                }
                if (state.dashboardMerchant && state.dashboardMerchant !== 'all') {
                    parts.push(`@ ${state.dashboardMerchant}`);
                }
                
                if (parts.length > 0) {
                    titleEl.textContent = `Tren Pengeluaran: ${parts.join(' - ')}`;
                } else {
                    titleEl.textContent = "Tren Pengeluaran Harian";
                }
            }

            if (subTitleEl) {
                const countTrans = state.entries ? getFilteredEntries().length : 0;
                subTitleEl.textContent = `Periode: ${periodLabel || 'Bulan Ini'} • ${countTrans} transaksi tercatat`;
                subTitleEl.classList.remove('hidden');
                subTitleEl.className = "text-[11px] text-[var(--text-muted)] font-medium block mt-0.5";
            }

            if (badgeEl) {
                badgeEl.textContent = formatRupiah(totalSpent);
            }

            const sortedDates = Object.keys(dailySums).sort();
            const labels = sortedDates.length > 0 ? sortedDates : ['Hari Ini'];
            const dataValues = sortedDates.length > 0 ? sortedDates.map(d => dailySums[d]) : [0];
            const lineColor = (activeCat && activeCat.color) || getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#10B981';

            // Formatter label tanggal (misal: "05 Nov")
            const formattedLabels = labels.map(d => {
                if (d === 'Hari Ini') return d;
                const parts = d.split('-');
                if (parts.length === 3) {
                    const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Ags", "Sep", "Okt", "Nov", "Des"];
                    const mIdx = parseInt(parts[1], 10) - 1;
                    return `${parseInt(parts[2], 10)} ${months[mIdx] || parts[1]}`;
                }
                return d;
            });

            state.trendChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: formattedLabels,
                    datasets: [{
                        label: 'Pengeluaran',
                        data: dataValues,
                        borderColor: lineColor,
                        backgroundColor: hexToRgba(lineColor, 0.12),
                        borderWidth: 2.5,
                        fill: true,
                        tension: 0.35,
                        pointBackgroundColor: lineColor,
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 2,
                        pointRadius: 4,
                        pointHoverRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function(ctx) { return ' Pengeluaran: ' + formatRupiah(ctx.parsed.y); }
                            }
                        }
                    },
                    scales: {
                        x: {
                            grid: {
                                display: false
                            },
                            ticks: {
                                font: { size: 10, weight: 'bold' },
                                color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#64748b',
                                maxRotation: 0,
                                autoSkip: true,
                                maxTicksLimit: 12
                            }
                        },
                        y: {
                            beginAtZero: true,
                            grid: {
                                color: getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim() || 'rgba(0,0,0,0.06)'
                            },
                            ticks: {
                                font: { size: 10 },
                                color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#64748b',
                                callback: function(val) {
                                    if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M';
                                    if (val >= 1000) return (val / 1000).toFixed(0) + 'k';
                                    return val;
                                }
                            }
                        }
                    }
                }
            });
        }

        /* ---------------- PERBANDINGAN 5 BULAN TERAKHIR (CHART BAR) ---------------- */
        function renderMonthlyComparisonChart() {
            const ctx = document.getElementById('monthlyComparisonChart');
            if (!ctx) return;

            if (state.monthlyCompareChartInstance) {
                state.monthlyCompareChartInstance.destroy();
            }

            const baseDate = state.dashboardMonthDate || new Date();
            const targetYear = baseDate.getFullYear();
            const targetMonth = baseDate.getMonth();

            const monthNamesShort = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Ags", "Sep", "Okt", "Nov", "Des"];
            const monthNamesFull = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

            // Siapkan 5 bulan terakhir berurutan secara kronologis (M-4 sampai M)
            const monthsData = [];
            for (let i = 4; i >= 0; i--) {
                const d = new Date(targetYear, targetMonth - i, 1);
                const y = d.getFullYear();
                const m = d.getMonth();
                const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
                monthsData.push({
                    date: d,
                    year: y,
                    monthIdx: m,
                    ym: ym,
                    shortLabel: `${monthNamesShort[m]} '${String(y).slice(-2)}`,
                    fullLabel: `${monthNamesFull[m]} ${y}`,
                    isCurrent: (i === 0),
                    total: 0,
                    txCount: 0
                });
            }

            const activeCat = (state.masterCategories || []).find(c => c.id === state.activeMasterCategoryId || c.sheetName === state.activeMasterCategoryId);
            const isAll = (state.activeMasterCategoryId === 'all');
            const hasSubCat = state.dashboardSubCategory && state.dashboardSubCategory !== 'all';
            const hasMerchant = state.dashboardMerchant && state.dashboardMerchant !== 'all';
            const searchKeyword = (state.dashboardSearch || '').trim().toLowerCase();

            // Agregasi seluruh transaksi yang sesuai filter aktif
            (state.entries || []).forEach(e => {
                if (!isAll && e.masterCategoryId !== state.activeMasterCategoryId && e.masterSheetName !== state.activeMasterCategoryId) {
                    return;
                }
                if (hasSubCat && (e.subCategory || '').trim() !== state.dashboardSubCategory) {
                    return;
                }
                if (hasMerchant && (e.merchant || '').trim() !== state.dashboardMerchant) {
                    return;
                }
                if (searchKeyword) {
                    const match = (e.itemName || '').toLowerCase().includes(searchKeyword) ||
                                  (e.merchant || '').toLowerCase().includes(searchKeyword) ||
                                  (e.subCategory || '').toLowerCase().includes(searchKeyword) ||
                                  (e.masterCategoryName || '').toLowerCase().includes(searchKeyword);
                    if (!match) return;
                }

                const ym = (e.date || '').substring(0, 7);
                const mObj = monthsData.find(m => m.ym === ym);
                if (mObj) {
                    mObj.total += getEntryNetCost(e);
                    mObj.txCount += 1;
                }
            });

            // Update Header Card (Judul, Subtitle, & Badge Rata-rata)
            const titleEl = document.getElementById('monthlyCompareChartTitle');
            const subTitleEl = document.getElementById('monthlyCompareChartSubtitle');
            const avgBadgeEl = document.getElementById('monthlyCompareAvgBadge');

            if (titleEl) {
                const parts = [];
                if (!isAll && activeCat) parts.push(activeCat.name);
                if (hasSubCat) parts.push(state.dashboardSubCategory);
                if (hasMerchant) parts.push(`@ ${state.dashboardMerchant}`);
                titleEl.textContent = parts.length > 0 ? `Perbandingan 5 Bulan: ${parts.join(' - ')}` : "Perbandingan 5 Bulan Terakhir";
            }

            const totalSum = monthsData.reduce((acc, m) => acc + m.total, 0);
            const avgMonthly = Math.round(totalSum / 5);

            if (avgBadgeEl) {
                avgBadgeEl.textContent = `${formatRupiah(avgMonthly)}/bln`;
            }

            if (subTitleEl) {
                const startRange = monthsData[0].shortLabel;
                const endRange = monthsData[4].shortLabel;
                subTitleEl.textContent = `Rentang: ${startRange} - ${endRange} • Total: ${formatRupiah(totalSum)}`;
            }

            const baseColor = (activeCat && activeCat.color) || getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#10B981';
            const textMuted = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#64748b';
            const borderColor = getComputedStyle(document.documentElement).getPropertyValue('--border-color').trim() || 'rgba(0,0,0,0.06)';

            // Styling bar: bulan yang sedang aktif disorot lebih tebal/pekat
            const bgColors = monthsData.map(m => m.isCurrent ? hexToRgba(baseColor, 0.88) : hexToRgba(baseColor, 0.35));
            const borderColors = monthsData.map(m => m.isCurrent ? baseColor : hexToRgba(baseColor, 0.7));
            const borderWidths = monthsData.map(m => m.isCurrent ? 2.5 : 1.5);

            state.monthlyCompareChartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: monthsData.map(m => m.shortLabel),
                    datasets: [{
                        label: 'Pengeluaran Bulanan',
                        data: monthsData.map(m => m.total),
                        backgroundColor: bgColors,
                        borderColor: borderColors,
                        borderWidth: borderWidths,
                        borderRadius: 6,
                        maxBarThickness: 42
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false
                    },
                    onClick: function(evt, elements) {
                        if (elements && elements.length > 0) {
                            const idx = elements[0].index;
                            const target = monthsData[idx];
                            if (target) {
                                state.dashboardMonthDate = new Date(target.year, target.monthIdx, 1);
                                state.dashboardPeriod = 'month';
                                const periodSelect = document.getElementById('dashboardPeriodSelect');
                                if (periodSelect) periodSelect.value = 'month';
                                renderDashboard();
                                if (typeof showToast === 'function') {
                                    showToast(`Beralih ke tampilan bulan ${target.fullLabel}`, 'info');
                                }
                            }
                        }
                    },
                    onHover: function(evt, elements) {
                        if (evt.native && evt.native.target) {
                            evt.native.target.style.cursor = (elements && elements.length > 0) ? 'pointer' : 'default';
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                title: function(items) {
                                    if (!items || items.length === 0) return '';
                                    const idx = items[0].dataIndex;
                                    return monthsData[idx].fullLabel + (monthsData[idx].isCurrent ? ' (Bulan Terpilih)' : '');
                                },
                                label: function(ctx) {
                                    const idx = ctx.dataIndex;
                                    const val = ctx.parsed.y;
                                    const lines = [' Pengeluaran: ' + formatRupiah(val)];
                                    if (idx > 0) {
                                        const prevVal = monthsData[idx - 1].total;
                                        if (prevVal > 0) {
                                            const diff = val - prevVal;
                                            const pct = ((diff / prevVal) * 100).toFixed(1);
                                            if (diff > 0) {
                                                lines.push(` Tren: +${pct}% vs ${monthsData[idx - 1].shortLabel}`);
                                            } else if (diff < 0) {
                                                lines.push(` Tren: ${pct}% vs ${monthsData[idx - 1].shortLabel}`);
                                            } else {
                                                lines.push(` Tren: 0% vs ${monthsData[idx - 1].shortLabel}`);
                                            }
                                        }
                                    }
                                    lines.push(` Volume: ${monthsData[idx].txCount} transaksi`);
                                    return lines;
                                },
                                footer: function() {
                                    return '💡 Klik bar untuk buka bulan ini';
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            grid: {
                                display: false
                            },
                            ticks: {
                                font: { size: 10, weight: 'bold' },
                                color: textMuted
                            }
                        },
                        y: {
                            beginAtZero: true,
                            grid: {
                                color: borderColor
                            },
                            ticks: {
                                font: { size: 10 },
                                color: textMuted,
                                callback: function(val) {
                                    if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M';
                                    if (val >= 1000) return (val / 1000).toFixed(0) + 'k';
                                    return val;
                                }
                            }
                        }
                    }
                }
            });
        }

        /* ---------------- KOMPOSISI PENGELUARAN (MENGIKUTI FILTER) ---------------- */
        function renderAnalyticsChart(periodCategorySums, periodCategoryCounts, periodTotalSpent, periodSubCategorySums, periodSubCategoryCounts) {
            const ctx = document.getElementById('mainAnalyticsChart');
            if (!ctx) return;

            if (state.chartInstance) {
                state.chartInstance.destroy();
            }

            const isAll = (state.activeMasterCategoryId === 'all');
            const activeCat = (state.masterCategories || []).find(c => c.id === state.activeMasterCategoryId || c.sheetName === state.activeMasterCategoryId);

            const chartTitleEl = document.getElementById('chartTitle');
            if (chartTitleEl) {
                if (isAll || !activeCat) {
                    chartTitleEl.textContent = "Komposisi Pengeluaran Per Modul";
                } else {
                    chartTitleEl.textContent = `Komposisi Sub-Kategori: ${activeCat.name}`;
                }
            }

            // Render Rincian Per Kategori / Sub-Kategori di bawah chart
            renderCategoryBreakdownList(periodCategorySums, periodCategoryCounts, periodTotalSpent, periodSubCategorySums, periodSubCategoryCounts);

            const SUB_PALETTE = [
                '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
                '#06B6D4', '#EC4899', '#84CC16', '#F97316', '#6366F1',
                '#14B8A6', '#A855F7', '#E11D48', '#0EA5E9', '#D97706'
            ];

            let labels = [];
            let dataValues = [];
            let colors = [];
            let itemIds = [];
            let isSubCategoryView = false;
            let activeTotal = 0;

            if (isAll || !activeCat) {
                // Tampilan Semua Master Kategori
                const catsWithSpent = (state.masterCategories || []).filter(c => (periodCategorySums && (periodCategorySums[c.id] || 0) > 0));

                if (catsWithSpent.length > 0) {
                    catsWithSpent.sort((a, b) => (periodCategorySums[b.id] || 0) - (periodCategorySums[a.id] || 0));
                    labels = catsWithSpent.map(c => c.name);
                    dataValues = catsWithSpent.map(c => periodCategorySums[c.id] || 0);
                    colors = catsWithSpent.map(c => c.color || '#10B981');
                    itemIds = catsWithSpent.map(c => c.id);
                } else {
                    labels = ['Belum Ada Pengeluaran'];
                    dataValues = [1];
                    colors = ['#cbd5e1'];
                    itemIds = ['none'];
                }
                activeTotal = periodTotalSpent;
            } else {
                // Tampilan Sub-Kategori dari Master Kategori yang Dipilih
                isSubCategoryView = true;
                const catSubSums = (periodSubCategorySums && periodSubCategorySums[activeCat.id]) || {};
                const catSpent = (periodCategorySums && periodCategorySums[activeCat.id]) || 0;
                activeTotal = catSpent;

                // Kumpulkan sub-kategori dengan belanja > 0
                const activeSubs = Object.keys(catSubSums).filter(s => (catSubSums[s] || 0) > 0);
                activeSubs.sort((a, b) => (catSubSums[b] || 0) - (catSubSums[a] || 0));

                if (activeSubs.length > 0) {
                    labels = activeSubs;
                    dataValues = activeSubs.map(s => catSubSums[s] || 0);
                    colors = activeSubs.map((s, idx) => SUB_PALETTE[idx % SUB_PALETTE.length]);
                    itemIds = activeSubs;
                } else {
                    labels = [`Belum Ada Belanja (${activeCat.name})`];
                    dataValues = [1];
                    colors = ['#cbd5e1'];
                    itemIds = ['none'];
                }
            }

            // Update Center Total Pengeluaran di Donut Chart
            const donutTotalEl = document.getElementById('donutChartTotalSpent');
            const donutLabelEl = document.getElementById('donutChartTotalLabel');
            const donutSubtextEl = document.getElementById('donutChartSubtext');
            const activeTxCount = (isAll || !activeCat)
                ? Object.values(periodCategoryCounts || {}).reduce((acc, count) => acc + (Number(count) || 0), 0)
                : ((periodCategoryCounts && periodCategoryCounts[activeCat.id]) || 0);

            if (donutTotalEl) {
                donutTotalEl.textContent = formatRupiah(activeTotal || 0);
            }
            if (donutLabelEl) {
                donutLabelEl.textContent = (isAll || !activeCat) ? 'Total Pengeluaran' : `Total ${activeCat.name}`;
            }
            if (donutSubtextEl) {
                if (activeTxCount > 0) {
                    donutSubtextEl.textContent = `${activeTxCount} transaksi`;
                    donutSubtextEl.classList.remove('hidden');
                } else {
                    donutSubtextEl.textContent = '';
                    donutSubtextEl.classList.add('hidden');
                }
            }

            state.chartInstance = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: dataValues,
                        backgroundColor: colors,
                        borderWidth: 2,
                        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--bg-surface').trim() || '#ffffff'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    onClick: (evt, elements) => {
                        if (!elements || elements.length === 0) return;
                        const idx = elements[0].index;
                        const selectedId = itemIds[idx];
                        if (!selectedId || selectedId === 'none') return;
                        if (!isSubCategoryView) {
                            handleCategoryBreakdownClick(selectedId);
                        } else {
                            selectDashboardSubCategoryFromBreakdown(selectedId);
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            callbacks: {
                                label: function(ctx) {
                                    if (itemIds[0] === 'none') return ' Belum ada pengeluaran di periode ini';
                                    const val = ctx.parsed;
                                    const pct = (activeTotal && activeTotal > 0) ? Math.round((val / activeTotal) * 100) : 0;
                                    if (!isSubCategoryView) {
                                        const cId = itemIds[ctx.dataIndex];
                                        const catBud = (typeof getCategoryBudget === 'function' && cId) ? getCategoryBudget(cId) : 0;
                                        if (catBud > 0) {
                                            const absorb = Math.round((val / catBud) * 100);
                                            return [
                                                ` ${ctx.label}: ${formatRupiah(val)} (${pct}% dari total)`,
                                                ` Target Anggaran: ${formatRupiah(catBud)} (${absorb}% terserap)`
                                            ];
                                        }
                                    } else if (activeCat) {
                                        const catBud = (typeof getCategoryBudget === 'function') ? getCategoryBudget(activeCat.id) : 0;
                                        if (catBud > 0) {
                                            const absorb = Math.round((val / catBud) * 100);
                                            return [
                                                ` ${ctx.label}: ${formatRupiah(val)} (${pct}% dari modul)`,
                                                ` Porsi dari Target (${formatRupiah(catBud)}): ${absorb}%`
                                            ];
                                        }
                                    }
                                    return ` ${ctx.label}: ${formatRupiah(val)} (${pct}%)`;
                                }
                            }
                        }
                    },
                    cutout: '68%'
                }
            });
        }

        /* ---------------- TAB PANE 3: PAGU & REALISASI PER MODUL (MENGIKUTI FILTER) ---------------- */
        function renderBudgetSubCategoryCards(filteredEntries, budgetMultiplier = 1, periodLabel = 'Bulan Ini') {
            const listContainer = document.getElementById('budgetSubCategoryList');
            if (!listContainer) return;

            const headerTitle = document.getElementById('budgetModulesHeaderTitle');
            if (headerTitle) {
                headerTitle.textContent = `Realisasi Berbanding Pagu Anggaran Modul (${periodLabel}):`;
            }

            if (!state.masterCategories || state.masterCategories.length === 0) {
                listContainer.innerHTML = `<div class="col-span-full p-4 text-center text-xs text-[var(--text-muted)]">Belum ada master kategori aktif.</div>`;
                return;
            }

            // Realisasi dari transaksi yang difilter (Menggunakan Realisasi Riil Uang Keluar)
            const categoryFilteredSums = {};
            (filteredEntries || []).forEach(e => {
                const cId = e.masterCategoryId || (state.masterCategories.find(c => c.name === e.masterCategoryName)?.id) || 'other';
                categoryFilteredSums[cId] = (categoryFilteredSums[cId] || 0) + getEntryNetCost(e);
            });

            // Tampilkan modul yang relevan (jika sedang memfilter 1 modul, tampilkan modul tersebut; jika 'all', tampilkan semua)
            const catsToDisplay = (state.activeMasterCategoryId && state.activeMasterCategoryId !== 'all')
                ? state.masterCategories.filter(c => c.id === state.activeMasterCategoryId || c.sheetName === state.activeMasterCategoryId)
                : state.masterCategories;

            let html = '';
            catsToDisplay.forEach(cat => {
                const catBaseBudget = getCategoryBudget(cat.id);
                const catBudget = Math.round(catBaseBudget * (budgetMultiplier || 1));
                const amt = categoryFilteredSums[cat.id] || 0;
                const catPct = catBudget > 0 ? Math.round((amt / catBudget) * 100) : (amt > 0 ? 100 : 0);
                const isOver = catBudget > 0 && amt > catBudget;

                let catStatusText = 'Aman';
                let catBadgeClass = 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20';
                let catBarColor = cat.color || 'var(--primary)';

                if (catPct >= 90) {
                    catStatusText = isOver ? 'Overbudget' : 'Kritis';
                    catBadgeClass = 'bg-rose-500/10 text-rose-600 border-rose-500/20';
                    catBarColor = '#ef4444';
                } else if (catPct >= 70) {
                    catStatusText = 'Waspada';
                    catBadgeClass = 'bg-amber-500/10 text-amber-600 border-amber-500/20';
                    catBarColor = '#f59e0b';
                }

                html += `
                    <div class="category-card p-3 bg-[var(--bg-surface)] space-y-2 cursor-pointer transition-all hover:scale-[1.01]" 
                        style="${getCategoryCardStyle(cat.color, { borderLeftWidth: '4.5px' })}"
                        onclick="handleMasterCategorySwitch('${cat.id}')">
                        <div class="flex items-center justify-between gap-2">
                            <div class="flex items-center gap-2 min-w-0">
                                <span class="w-7 h-7 rounded-lg flex items-center justify-center text-xs shrink-0" style="background-color: ${hexToRgba(cat.color, 0.15)}; color: ${cat.color};">
                                    <i class="fa-solid ${cat.icon || 'fa-folder'}"></i>
                                </span>
                                <div class="min-w-0">
                                    <h5 class="font-bold text-[var(--text-main)] truncate text-xs">${escapeHtml(cat.name)}</h5>
                                    <span class="text-[10px] text-[var(--text-muted)] font-mono">${cat.sheetName}</span>
                                </div>
                            </div>
                            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${catBadgeClass}">
                                ${catStatusText}
                            </span>
                        </div>

                        <!-- Progress Bar Modul -->
                        <div class="space-y-1">
                            <div class="flex items-center justify-between text-[11px]">
                                <span class="font-semibold text-[var(--text-muted)]">Realisasi: <b class="text-[var(--text-main)]">${formatRupiah(amt)}</b></span>
                                <span class="font-bold ${isOver ? 'text-rose-500' : 'text-[var(--text-main)]'}">${catPct}%</span>
                            </div>
                            <div class="w-full bg-[var(--border-color)] h-2 rounded-full overflow-hidden">
                                <div class="h-full rounded-full transition-all duration-300" style="width: ${Math.min(catPct, 100)}%; background-color: ${catBarColor};"></div>
                            </div>
                        </div>

                        <!-- Target & Sisa Saldo Modul -->
                        <div class="flex items-center justify-between text-[10px] text-[var(--text-muted)] pt-1 border-t border-[var(--border-color)]/60">
                            <span>Pagu: <b class="font-semibold text-[var(--text-main)]">${formatRupiah(catBudget)}</b></span>
                            <span class="${isOver ? 'text-rose-500 font-bold' : 'text-emerald-600 font-medium'}">
                                ${isOver ? 'Lebih ' + formatRupiah(amt - catBudget) : 'Sisa ' + formatRupiah(Math.max(catBudget - amt, 0))}
                            </span>
                        </div>
                    </div>
                `;
            });

            listContainer.innerHTML = html;
        }

        function renderDashboardRecentReceipts() {
            const container = document.getElementById('dashboardRecentReceipts');
            if (!container) return;

            const filteredEntries = getFilteredEntries();
            const allowedReceiptIds = new Set(filteredEntries.map(e => e.receiptId));

            // Urutkan struk mengikuti sorting yang aktif
            const sortMode = state.dashboardSort || 'date_desc';
            let recs = state.receipts.filter(r => allowedReceiptIds.has(r.receiptId));
            if (sortMode === 'cost_desc') {
                recs.sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0));
            } else if (sortMode === 'cost_asc') {
                recs.sort((a, b) => (a.totalCost || 0) - (b.totalCost || 0));
            } else if (sortMode === 'date_asc') {
                recs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
            } else if (sortMode === 'name_asc') {
                recs.sort((a, b) => (a.merchant || '').localeCompare(b.merchant || ''));
            } else {
                recs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            }
            recs = recs.slice(0, 6);

            if (recs.length === 0) {
                container.innerHTML = `<div class="col-span-full p-4 text-center text-xs text-[var(--text-muted)]">Belum ada transaksi struk pada filter ini.</div>`;
                return;
            }

            let html = '';
            recs.forEach(r => {
                const catObj = state.masterCategories.find(c => c.id === r.masterCategoryId || c.sheetName === r.masterSheetName) || { name: 'Umum', color: '#10B981', icon: 'fa-receipt' };
                html += `
                    <div class="category-card p-3.5 bg-[var(--bg-surface)] flex items-center justify-between gap-3 cursor-pointer group" 
                        style="${getCategoryCardStyle(catObj.color, { borderLeftWidth: '4.5px' })}" 
                        onclick="viewReceiptInHistory('${r.receiptId}')">
                        <div class="flex items-center gap-3 min-w-0">
                            <span class="w-9 h-9 rounded-xl flex items-center justify-center text-sm flex-shrink-0 transition-transform group-hover:scale-105" style="background-color: ${hexToRgba(catObj.color, 0.15)}; color: ${catObj.color};">
                                <i class="fa-solid ${catObj.icon}"></i>
                            </span>
                            <div class="min-w-0">
                                <h4 class="text-xs font-bold text-[var(--text-main)] truncate">${escapeHtml(r.merchant || "Belanja")}</h4>
                                <span class="text-[10px] text-[var(--text-muted)] block truncate">${r.date || "-"} • ${r.items ? r.items.length : 1} item${r.createdByName ? ` • <span class="text-emerald-600 dark:text-emerald-400 font-medium"><i class="fa-solid fa-user-pen text-[9px]"></i> ${escapeHtml(r.createdByName)}</span>` : ''}</span>
                            </div>
                        </div>
                        <div class="text-right flex-shrink-0">
                            <span class="text-xs font-extrabold text-[var(--text-main)] block">${formatRupiah(r.totalCost)}</span>
                            <span class="text-[9px] font-bold px-1.5 py-0.5 rounded" style="background-color: ${hexToRgba(catObj.color, 0.15)}; color: ${catObj.color};">${escapeHtml(catObj.name)}</span>
                        </div>
                    </div>
                `;
            });

            container.innerHTML = html;
        }

        function viewReceiptInHistory(receiptId) {
            setAppMode('history');
            const search = document.getElementById('historySearchInput');
            if (search) {
                search.value = receiptId;
            }
            const periodSelect = document.getElementById('historyPeriodFilter');
            if (periodSelect) {
                periodSelect.value = 'all';
                handleHistoryPeriodChange('all');
            } else {
                filterHistoryList();
            }
        }

        /* ========================================================
           5. INPUT TRANSAKSI (MULTI-ITEM FORM & AI RECEIPT SCANNER)
           ======================================================== */
        function handleFormCategoryChange(catId) {
            const isMulti = catId === 'all';
            const banner = document.getElementById('multiModuleActiveBanner');
            const multiConf = getMultiModuleConfig();
            const multiColor = multiConf.color || '#10B981';

            if (banner) {
                banner.classList.add('hidden');
                banner.style.display = 'none';
            }

            if (isMulti) {
                applyDynamicAccentColor(multiColor);
            } else {
                const cat = state.masterCategories.find(c => c.id === catId);
                if (cat && cat.color) {
                    applyDynamicAccentColor(cat.color);
                }
                updateItemSubCategoryOptions();
            }

            syncItemRowsMultiModuleLayout();
        }

        function updateItemSubCategoryOptions() {
            const formCatSelect = document.getElementById('formMasterCategorySelect');
            if (formCatSelect && formCatSelect.value === 'all') {
                return; // Pada mode semua modul, subkategori dikelola per-baris sesuai modul masing-masing
            }
            const catId = formCatSelect ? formCatSelect.value : state.masterCategories[0].id;
            const cat = state.masterCategories.find(c => c.id === catId) || state.masterCategories[0];
            const subCats = (cat.subCategories && cat.subCategories.length > 0) ? [...cat.subCategories] : [];
            const hasLainnyaOrOther = subCats.some(s => s.toLowerCase() === "lainnya/other" || s.toLowerCase() === "lainnya" || s.toLowerCase() === "other");
            if (!hasLainnyaOrOther) {
                subCats.push("Lainnya/Other");
            } else {
                const idxL = subCats.findIndex(s => s.toLowerCase() === "lainnya");
                if (idxL !== -1 && !subCats.includes("Lainnya/Other")) {
                    subCats[idxL] = "Lainnya/Other";
                }
            }

            const subCatSelects = document.querySelectorAll('.item-subcategory-select');
            subCatSelects.forEach(sel => {
                const curVal = sel.value;
                let html = '';
                subCats.forEach(s => {
                    const isSel = (curVal && curVal === s) || (!curVal && s === 'Lainnya/Other');
                    html += `<option value="${escapeHtml(s)}" ${isSel ? 'selected' : ''}>${escapeHtml(s)}</option>`;
                });
                sel.innerHTML = html;
                if (curVal && subCats.includes(curVal)) {
                    sel.value = curVal;
                } else {
                    sel.value = "Lainnya/Other";
                }
            });
        }

        function handleItemCategoryChange(sel, idx) {
            const catId = sel.value;
            const cat = state.masterCategories.find(c => c.id === catId) || state.masterCategories[0];
            const rowDiv = document.getElementById(`item-row-${idx}`);
            if (!rowDiv) return;

            // Update border row dan shadow mengikuti warna master kategori (5 Prinsip Card Border)
            if (cat && cat.color) {
                rowDiv.style.cssText = getCategoryCardStyle(cat.color, { borderLeftWidth: '4px', radius: '14px' });
            }

            // Update badge di header baris
            const badge = rowDiv.querySelector('.item-cat-badge');
            if (badge && cat) {
                badge.innerText = cat.name;
                badge.style.backgroundColor = hexToRgba(cat.color || '#10B981', 0.15);
                badge.style.color = cat.color || '#10B981';
            }

            // Update dropdown subkategori baris ini
            const subCatSelect = rowDiv.querySelector('.item-subcategory-select');
            if (subCatSelect && cat) {
                const subCats = (cat.subCategories && cat.subCategories.length > 0) ? [...cat.subCategories] : [];
                const hasLainnyaOrOther = subCats.some(s => s.toLowerCase() === "lainnya/other" || s.toLowerCase() === "lainnya" || s.toLowerCase() === "other");
                if (!hasLainnyaOrOther) {
                    subCats.push("Lainnya/Other");
                } else {
                    const idxL = subCats.findIndex(s => s.toLowerCase() === "lainnya");
                    if (idxL !== -1 && !subCats.includes("Lainnya/Other")) {
                        subCats[idxL] = "Lainnya/Other";
                    }
                }
                let html = '';
                subCats.forEach(s => {
                    const isSel = s === "Lainnya/Other";
                    html += `<option value="${escapeHtml(s)}" ${isSel ? 'selected' : ''}>${escapeHtml(s)}</option>`;
                });
                subCatSelect.innerHTML = html;
                subCatSelect.value = "Lainnya/Other";
            }
        }

        function syncItemRowsMultiModuleLayout() {
            const formCatSelect = document.getElementById('formMasterCategorySelect');
            const isMulti = formCatSelect && formCatSelect.value === 'all';
            const container = document.getElementById('formItemsContainer');
            if (!container) return;

            const rows = container.querySelectorAll('.item-row-box');
            rows.forEach(r => {
                const catCol = r.querySelector('.item-category-col');
                const nameCol = r.querySelector('.item-name-col');
                const subcatCol = r.querySelector('.item-subcat-col');
                const qtyCol = r.querySelector('.item-qty-col');
                const badge = r.querySelector('.item-cat-badge');

                if (isMulti) {
                    if (catCol) {
                        catCol.classList.remove('hidden');
                        catCol.classList.add('sm:col-span-3');
                    }
                    if (nameCol) {
                        nameCol.classList.remove('sm:col-span-5');
                        nameCol.classList.add('sm:col-span-4');
                    }
                    if (subcatCol) {
                        subcatCol.classList.remove('sm:col-span-3');
                        subcatCol.classList.add('sm:col-span-2');
                    }
                    if (qtyCol) {
                        qtyCol.classList.remove('sm:col-span-2');
                        qtyCol.classList.add('sm:col-span-1');
                    }
                    if (badge) {
                        badge.classList.remove('hidden');
                        badge.classList.add('inline-block');
                    }
                } else {
                    if (catCol) {
                        catCol.classList.add('hidden');
                        catCol.classList.remove('sm:col-span-3');
                    }
                    if (nameCol) {
                        nameCol.classList.remove('sm:col-span-4');
                        nameCol.classList.add('sm:col-span-5');
                    }
                    if (subcatCol) {
                        subcatCol.classList.remove('sm:col-span-2');
                        subcatCol.classList.add('sm:col-span-3');
                    }
                    if (qtyCol) {
                        qtyCol.classList.remove('sm:col-span-1');
                        qtyCol.classList.add('sm:col-span-2');
                    }
                    if (badge) {
                        badge.classList.add('hidden');
                        badge.classList.remove('inline-block');
                    }
                }
            });
        }

        function addNewItemRow(data = {}) {
            state.formItemIndexCounter++;
            const idx = state.formItemIndexCounter;
            const container = document.getElementById('formItemsContainer');
            if (!container) return;

            const formCatSelect = document.getElementById('formMasterCategorySelect');
            const isMulti = formCatSelect ? formCatSelect.value === 'all' : false;
            const selectedCatId = data.masterCategoryId || (isMulti ? (state.masterCategories[0] ? state.masterCategories[0].id : '') : (formCatSelect ? formCatSelect.value : (state.masterCategories[0] ? state.masterCategories[0].id : '')));
            const selectedCat = state.masterCategories.find(c => c.id === selectedCatId) || state.masterCategories[0];
            const rawSubCats = (selectedCat && selectedCat.subCategories && selectedCat.subCategories.length > 0) ? [...selectedCat.subCategories] : [];
            
            // Pastikan opsi 'Lainnya/Other' selalu ada di semua modul kategori
            const hasLainnyaOrOther = rawSubCats.some(s => s.toLowerCase() === "lainnya/other" || s.toLowerCase() === "lainnya" || s.toLowerCase() === "other");
            if (!hasLainnyaOrOther) {
                rawSubCats.push("Lainnya/Other");
            } else {
                const idxL = rawSubCats.findIndex(s => s.toLowerCase() === "lainnya");
                if (idxL !== -1 && !rawSubCats.includes("Lainnya/Other")) {
                    rawSubCats[idxL] = "Lainnya/Other";
                }
            }

            const targetSub = data.subCategory || "Lainnya/Other";

            const photoUrl = data.itemPhotoUrl || data.photoUrl || '';

            const rowDiv = document.createElement('div');
            rowDiv.id = `item-row-${idx}`;
            rowDiv.className = "category-card item-row-box p-2.5 sm:p-3 bg-[var(--bg-surface)] space-y-2.5";
            if (selectedCat && selectedCat.color) {
                rowDiv.style.cssText = getCategoryCardStyle(selectedCat.color, { borderLeftWidth: '4px', radius: '14px' });
            }

            let categoryOptions = '';
            state.masterCategories.forEach(cat => {
                const sel = cat.id === selectedCatId ? 'selected' : '';
                categoryOptions += `<option value="${cat.id}" ${sel}>${escapeHtml(cat.name)}</option>`;
            });

            let subCatOptions = '';
            let hasSelected = false;
            rawSubCats.forEach(s => {
                const isMatch = targetSub && (
                    targetSub.trim().toLowerCase() === s.trim().toLowerCase() ||
                    targetSub.trim().toLowerCase().includes(s.trim().toLowerCase()) ||
                    s.trim().toLowerCase().includes(targetSub.trim().toLowerCase())
                );
                if (isMatch) hasSelected = true;
                const sel = isMatch ? 'selected' : '';
                subCatOptions += `<option value="${escapeHtml(s)}" ${sel}>${escapeHtml(s)}</option>`;
            });
            if (!hasSelected) {
                subCatOptions = `<option value="Lainnya/Other" selected>Lainnya/Other</option>` + subCatOptions;
            }

            rowDiv.innerHTML = `
                <div class="flex items-center justify-between pb-1.5 border-b border-[var(--border-color)]">
                    <div class="flex items-center gap-2">
                        <span class="w-5 h-5 rounded-full bg-[var(--primary-light)] text-[var(--primary)] flex items-center justify-center text-[10px] font-black">${idx}</span>
                        <span class="text-xs font-bold text-[var(--text-main)]">Barang</span>
                        <span id="itemCatBadge_${idx}" class="item-cat-badge text-[10px] font-bold px-2 py-0.5 rounded-full ${isMulti ? 'inline-block' : 'hidden'}" style="background-color: ${hexToRgba(selectedCat ? selectedCat.color : '#10B981', 0.15)}; color: ${selectedCat ? selectedCat.color : '#10B981'};">
                            ${escapeHtml(selectedCat ? selectedCat.name : '')}
                        </span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <!-- Input File & Hidden Base64 Foto Barang -->
                        <input type="file" id="itemPhotoInput_${idx}" accept="image/*" class="hidden" onchange="handleItemRowPhotoUpload(event, ${idx})">
                        <input type="hidden" class="item-photo-base64" id="itemPhotoBase64_${idx}" value="${escapeHtml(photoUrl)}">
                        
                        <!-- Box Preview Foto Barang Jika Terlampir -->
                        <div id="itemPhotoPreviewBox_${idx}" class="${photoUrl ? 'flex' : 'hidden'} items-center gap-1 bg-[var(--bg-main)] px-1.5 py-0.5 rounded-lg border border-[var(--border-color)]">
                            <button type="button" onclick="previewItemRowPhoto(${idx})" class="w-6 h-6 rounded-md border border-[var(--border-color)] overflow-hidden shrink-0 group relative hover:opacity-80 transition" title="Perbesar Foto">
                                <img id="itemPhotoThumb_${idx}" src="${photoUrl}" class="w-full h-full object-cover">
                            </button>
                            <button type="button" onclick="document.getElementById('itemPhotoInput_${idx}').click()" class="text-[11px] text-[var(--text-muted)] hover:text-[var(--primary)] p-0.5" title="Ganti Foto">
                                <i class="fa-solid fa-arrows-rotate"></i>
                            </button>
                            <button type="button" onclick="removeItemRowPhoto(${idx})" class="text-[11px] text-rose-500 hover:text-rose-700 p-0.5" title="Hapus Foto">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>

                        <!-- Tombol Tambah Foto Barang -->
                        <button id="itemPhotoBtn_${idx}" type="button" onclick="document.getElementById('itemPhotoInput_${idx}').click()" class="${photoUrl ? 'hidden' : 'inline-flex'} items-center gap-1 text-[11px] font-semibold text-[var(--text-muted)] hover:text-[var(--primary)] px-2 py-0.5 rounded-lg border border-dashed border-[var(--border-color)] hover:border-[var(--primary)] transition" title="Lampirkan foto barang">
                            <i class="fa-solid fa-camera text-[10px]"></i>
                            <span>+ Foto</span>
                        </button>

                        <button type="button" onclick="removeItemRow(${idx})" class="text-xs text-rose-500 hover:text-rose-700 font-bold p-1 ml-1" title="Hapus Barang">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                    <div class="item-category-col ${isMulti ? 'sm:col-span-3' : 'hidden'}">
                        <label class="block text-[11px] font-semibold text-[var(--text-muted)] mb-1">Modul Kategori</label>
                        <select class="custom-select item-category-select text-xs font-bold" onchange="handleItemCategoryChange(this, ${idx})">
                            ${categoryOptions}
                        </select>
                    </div>
                    <div class="item-name-col ${isMulti ? 'sm:col-span-4' : 'sm:col-span-5'}">
                        <label class="block text-[11px] font-semibold text-[var(--text-muted)] mb-1">Nama Barang</label>
                        <input type="text" class="custom-input item-name-input text-xs" placeholder="Contoh: Beras Ramos 5kg (Opsional)" value="${escapeHtml(data.itemName || '')}">
                    </div>
                    <div class="item-subcat-col ${isMulti ? 'sm:col-span-2' : 'sm:col-span-3'}">
                        <label class="block text-[11px] font-semibold text-[var(--text-muted)] mb-1">Sub Kategori</label>
                        <select class="custom-select item-subcategory-select text-xs">
                            ${subCatOptions}
                        </select>
                    </div>
                    <div class="item-qty-col ${isMulti ? 'sm:col-span-1' : 'sm:col-span-2'}">
                        <label class="block text-[11px] font-semibold text-[var(--text-muted)] mb-1">Qty</label>
                        <input type="number" min="1" class="custom-input item-qty-input text-xs font-bold" value="${data.qty || 1}" oninput="calculateFormGrandTotal(true)">
                    </div>
                    <div class="item-cost-col sm:col-span-2">
                        <label class="block text-[11px] font-semibold text-[var(--text-muted)] mb-1">Biaya (Rp)</label>
                        <input type="text" inputmode="numeric" class="custom-input item-cost-input text-xs font-bold" placeholder="0" value="${formatThousand(data.cost || '')}" oninput="handleThousandInput(this, () => calculateFormGrandTotal(true))">
                    </div>
                </div>
            `;

            container.appendChild(rowDiv);

            // UX Quick Entry: Tekan Enter pada kolom harga untuk langsung tambah baris baru & fokus
            const costInp = rowDiv.querySelector('.item-cost-input');
            if (costInp) {
                costInp.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        addNewItemRow();
                        setTimeout(() => {
                            const allNames = container.querySelectorAll('.item-name-input');
                            if (allNames.length > 0) allNames[allNames.length - 1].focus();
                        }, 50);
                    }
                });
            }

            updateItemCountBadge();
            calculateFormGrandTotal(true);
        }

        function handleItemRowPhotoUpload(e, idx) {
            const file = e.target.files && e.target.files[0];
            if (!file) return;

            compressImageFile(file, 900, 0.8, function(dataUrl) {
                if (!dataUrl) {
                    showToast("Format gambar tidak didukung atau rusak.", "error");
                    return;
                }
                const hiddenInp = document.getElementById(`itemPhotoBase64_${idx}`);
                const thumbImg = document.getElementById(`itemPhotoThumb_${idx}`);
                const previewBox = document.getElementById(`itemPhotoPreviewBox_${idx}`);
                const btnUpload = document.getElementById(`itemPhotoBtn_${idx}`);

                if (hiddenInp) hiddenInp.value = dataUrl;
                if (thumbImg) thumbImg.src = dataUrl;
                if (previewBox) {
                    previewBox.classList.remove('hidden');
                    previewBox.classList.add('flex');
                }
                if (btnUpload) btnUpload.classList.add('hidden');
                showToast("Foto barang berhasil ditambahkan.");
            });
        }

        function removeItemRowPhoto(idx) {
            const fileInp = document.getElementById(`itemPhotoInput_${idx}`);
            const hiddenInp = document.getElementById(`itemPhotoBase64_${idx}`);
            const thumbImg = document.getElementById(`itemPhotoThumb_${idx}`);
            const previewBox = document.getElementById(`itemPhotoPreviewBox_${idx}`);
            const btnUpload = document.getElementById(`itemPhotoBtn_${idx}`);

            if (fileInp) fileInp.value = '';
            if (hiddenInp) hiddenInp.value = '';
            if (thumbImg) thumbImg.src = '';
            if (previewBox) {
                previewBox.classList.remove('flex');
                previewBox.classList.add('hidden');
            }
            if (btnUpload) btnUpload.classList.remove('hidden');
            showToast("Foto barang dihapus.");
        }

        function previewItemRowPhoto(idx) {
            const hiddenInp = document.getElementById(`itemPhotoBase64_${idx}`);
            const row = document.getElementById(`item-row-${idx}`);
            const nameInp = row ? row.querySelector('.item-name-input') : null;
            const itemName = (nameInp && nameInp.value.trim()) ? nameInp.value.trim() : `Barang #${idx}`;

            if (!hiddenInp || !hiddenInp.value) {
                showToast("Belum ada foto barang yang dilampirkan.");
                return;
            }
            openPhotoPreviewModal(`Foto: ${itemName}`, hiddenInp.value);
        }

        function removeItemRow(idx) {
            const container = document.getElementById('formItemsContainer');
            if (!container) return;

            const row = document.getElementById(`item-row-${idx}`);
            if (row) row.remove();
            updateItemCountBadge();
            calculateFormGrandTotal(true);
        }

        function updateItemCountBadge() {
            const container = document.getElementById('formItemsContainer');
            const badge = document.getElementById('formItemCount');
            const placeholder = document.getElementById('formItemsEmptyPlaceholder');
            if (container && badge) {
                const count = container.querySelectorAll('.item-row-box').length;
                badge.innerText = count;
                if (placeholder) {
                    placeholder.classList.add('hidden');
                    placeholder.style.display = 'none';
                }
            }
        }

        function calculateFormGrandTotal(autoCalculateSubtotal = true) {
            const container = document.getElementById('formItemsContainer');
            const subtotalInp = document.getElementById('formSubtotalDisplay');
            if (!subtotalInp) return;

            let subtotal = 0;
            const rows = container ? container.querySelectorAll('.item-row-box') : [];

            if (autoCalculateSubtotal && rows.length > 0) {
                rows.forEach(r => {
                    const cost = parseThousand(r.querySelector('.item-cost-input')?.value);
                    const qty = Number(r.querySelector('.item-qty-input')?.value) || 1;
                    subtotal += (cost * qty);
                });
                subtotalInp.value = formatThousand(subtotal);
            } else {
                subtotal = parseThousand(subtotalInp.value);
            }

            const discount = parseThousand(document.getElementById('formDiscount')?.value);
            const tax = parseThousand(document.getElementById('formTax')?.value);
            const other = parseSignedThousand(document.getElementById('formOther')?.value);
            const grandTotal = Math.max(0, subtotal - discount + tax + other);

            const grandTotalDisplay = document.getElementById('formGrandTotalDisplay');
            if (grandTotalDisplay) grandTotalDisplay.innerText = formatRupiah(grandTotal);
        }

        function handleReceiptPhotoAttachment(e) {
            const file = e.target.files && e.target.files[0];
            if (!file) return;

            compressImageFile(file, 1200, 0.85, function(base64) {
                if (!base64) {
                    showToast("Format gambar tidak didukung atau rusak.", "error");
                    return;
                }
                updateFormReceiptPhotoDisplay(base64);
                showToast("Foto struk berhasil dilampirkan.");
            });
        }

        function updateFormReceiptPhotoDisplay(photoUrl) {
            const hiddenInput = document.getElementById('formReceiptPhotoBase64');
            const placeholder = document.getElementById('formReceiptUploadPlaceholder');
            const attachedBox = document.getElementById('formReceiptAttachedBox');
            const thumbImg = document.getElementById('formReceiptPhotoThumb');
            const peekBanner = document.getElementById('stickyReceiptPeekBanner');

            if (photoUrl) {
                if (hiddenInput) hiddenInput.value = photoUrl;
                if (thumbImg) thumbImg.src = photoUrl;
                if (placeholder) placeholder.classList.add('hidden');
                if (attachedBox) {
                    attachedBox.classList.remove('hidden');
                    attachedBox.classList.add('flex');
                }
                if (peekBanner) {
                    peekBanner.classList.remove('hidden');
                    peekBanner.classList.add('flex');
                }
            } else {
                if (hiddenInput) hiddenInput.value = '';
                const fileInput = document.getElementById('formReceiptPhotoInput');
                if (fileInput) fileInput.value = '';
                if (thumbImg) thumbImg.src = '';
                if (placeholder) placeholder.classList.remove('hidden');
                if (attachedBox) {
                    attachedBox.classList.remove('flex');
                    attachedBox.classList.add('hidden');
                }
                if (peekBanner) {
                    peekBanner.classList.remove('flex');
                    peekBanner.classList.add('hidden');
                }
            }
        }

        function removeFormReceiptPhoto() {
            updateFormReceiptPhotoDisplay('');
            showToast("Bukti foto struk dihapus.");
        }

        function previewCurrentFormReceipt() {
            const photoVal = document.getElementById('formReceiptPhotoBase64')?.value;
            const merchant = document.getElementById('formMerchant')?.value || 'Struk Belanja';
            if (!photoVal) {
                showToast("Belum ada bukti foto struk yang dilampirkan.");
                return;
            }
            openPhotoPreviewModal(`Struk: ${merchant}`, photoVal);
        }

        function handleFormResetOrCancel() {
            const editId = document.getElementById('editReceiptId')?.value.trim();
            if (editId) {
                cancelEditTransaction();
            } else {
                resetTransactionForm();
                showToast("Formulir transaksi dibersihkan.", "info", 1500);
            }
        }

        function cancelEditTransaction() {
            resetTransactionForm();
            showToast("Mode edit dibatalkan. Formulir kembali ke mode Input Baru.", "info", 2000);
        }

        function updateTransactionFormModeUI(receiptData = null) {
            const editIdInput = document.getElementById('editReceiptId');
            const editId = (editIdInput ? editIdInput.value.trim() : '');
            const isEdit = !!editId;

            const form = document.getElementById('transactionForm');
            const editBanner = document.getElementById('formEditModeBanner');
            const editBannerId = document.getElementById('editBannerReceiptId');
            const editBannerMerchant = document.getElementById('editBannerMerchant');
            const formTitle = document.getElementById('formTitle');
            const formTitleDot = document.getElementById('formTitleDot');
            const formTitleBadge = document.getElementById('formTitleBadge');

            const submitBtn = document.getElementById('btnSubmitForm');
            const submitIcon = document.getElementById('btnSubmitIcon');
            const submitText = document.getElementById('btnSubmitText');
            
            const resetBtn = document.getElementById('btnResetForm');
            const resetIcon = document.getElementById('btnResetIcon');
            const resetText = document.getElementById('btnResetText');

            const topCard = document.getElementById('inputMenuHeaderCard');
            const topIcon = document.getElementById('inputMenuHeaderIcon');
            const topTitle = document.getElementById('inputMenuHeaderTitle');
            const topBadge = document.getElementById('inputMenuHeaderBadge');
            const switchBtn = document.getElementById('btnSwitchToNewInput');

            // Pasang event listener live pada merchant input jika belum ada
            const mInp = document.getElementById('formMerchant');
            if (mInp && !mInp.dataset.hasModeListener) {
                mInp.dataset.hasModeListener = "true";
                mInp.addEventListener('input', () => {
                    const eb = document.getElementById('editBannerMerchant');
                    if (eb && document.getElementById('editReceiptId')?.value.trim()) {
                        eb.innerText = mInp.value.trim() || 'Transaksi';
                    }
                });
            }

            if (isEdit) {
                // ================= MODE EDIT AKTIF =================
                // 1. Tampilan Kartu Form (Border & Highlight Amber)
                if (form) {
                    form.classList.add('form-mode-edit-active');
                }

                // 2. Banner Indikator Edit
                if (editBanner) {
                    editBanner.classList.remove('hidden');
                    editBanner.classList.add('flex');
                }
                if (editBannerId) {
                    editBannerId.innerText = editId;
                }
                if (editBannerMerchant) {
                    const mName = receiptData?.merchant || document.getElementById('formMerchant')?.value || 'Transaksi';
                    editBannerMerchant.innerText = mName;
                }

                // 3. Header Form Title & Badges
                if (formTitleDot) {
                    formTitleDot.className = "w-2.5 h-2.5 rounded-full bg-amber-500 shrink-0 animate-ping";
                }
                if (formTitle) {
                    formTitle.innerHTML = `Edit Transaksi: <span class="font-mono text-amber-600 dark:text-amber-400 font-extrabold">${escapeHtml(editId)}</span>`;
                }
                if (formTitleBadge) {
                    formTitleBadge.className = "text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700 flex items-center gap-1";
                    formTitleBadge.innerHTML = `<i class="fa-solid fa-pen-to-square text-[9px]"></i> Mode Edit`;
                }

                // 4. Tombol Simpan (Visual Berbeda: Amber Glow, Ikon Edit, Teks Khusus)
                if (submitBtn) {
                    submitBtn.className = "btn-submit-edit text-xs py-2.5 px-5 rounded-xl font-black flex items-center gap-2 shadow-lg transition-all active:scale-95 cursor-pointer";
                    submitBtn.title = `Simpan perubahan pada transaksi ${editId}`;
                }
                if (submitIcon) {
                    submitIcon.className = "fa-solid fa-floppy-disk text-amber-100";
                }
                if (submitText) {
                    submitText.innerText = "Simpan Perubahan (Edit)";
                }

                // 5. Tombol Reset beralih fungsi menjadi Batal Edit
                if (resetBtn) {
                    resetBtn.className = "px-3.5 py-2.5 rounded-xl text-xs font-bold border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/60 flex items-center gap-1.5 transition-all shadow-2xs cursor-pointer";
                    resetBtn.title = "Batalkan pengeditan dan kembali ke input transaksi baru";
                }
                if (resetIcon) {
                    resetIcon.className = "fa-solid fa-xmark text-rose-500 text-xs";
                }
                if (resetText) {
                    resetText.innerText = "Batal Edit";
                }

                // 6. Header Menu Input
                if (topIcon) {
                    topIcon.style.backgroundColor = "#D97706";
                    topIcon.innerHTML = `<i class="fa-solid fa-pen-to-square text-sm"></i>`;
                }
                if (topTitle) {
                    topTitle.innerText = "Edit Transaksi";
                }
                if (topBadge) {
                    topBadge.className = "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700 animate-pulse";
                    topBadge.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Sedang Mengedit Transaksi`;
                }
                if (switchBtn) {
                    switchBtn.classList.remove('hidden');
                    switchBtn.classList.add('inline-flex');
                }
            } else {
                // ================= MODE INPUT BARU =================
                // 1. Tampilan Kartu Form Default
                if (form) {
                    form.classList.remove('form-mode-edit-active');
                }

                // 2. Sembunyikan Banner Edit
                if (editBanner) {
                    editBanner.classList.add('hidden');
                    editBanner.classList.remove('flex');
                }

                // 3. Header Form Title & Badges
                if (formTitleDot) {
                    formTitleDot.className = "w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0";
                }
                if (formTitle) {
                    formTitle.innerText = "Rincian Transaksi Baru";
                }
                if (formTitleBadge) {
                    formTitleBadge.className = "text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-300/60 dark:border-emerald-800/60 flex items-center gap-1";
                    formTitleBadge.innerHTML = `<i class="fa-solid fa-circle-plus text-[9px] text-emerald-500"></i> Input Baru`;
                }

                // 4. Tombol Simpan (Visual Normal / Default: Emerald Theme)
                if (submitBtn) {
                    submitBtn.className = "btn-primary btn-submit-new text-xs py-2.5 px-5 rounded-xl font-bold flex items-center gap-2 shadow-xs transition-all active:scale-95 cursor-pointer";
                    submitBtn.title = "Simpan sebagai transaksi baru";
                }
                if (submitIcon) {
                    submitIcon.className = "fa-solid fa-floppy-disk";
                }
                if (submitText) {
                    submitText.innerText = "Simpan Transaksi Baru";
                }

                // 5. Tombol Reset Kembali Normal
                if (resetBtn) {
                    resetBtn.className = "btn-secondary text-xs py-2.5 px-4 rounded-xl font-semibold flex items-center gap-1.5 transition-all cursor-pointer";
                    resetBtn.title = "Kosongkan formulir transaksi";
                }
                if (resetIcon) {
                    resetIcon.className = "fa-solid fa-arrow-rotate-left text-[11px] text-[var(--text-muted)]";
                }
                if (resetText) {
                    resetText.innerText = "Reset";
                }

                // 6. Header Menu Input
                if (topIcon) {
                    topIcon.style.backgroundColor = "var(--primary)";
                    topIcon.innerHTML = `<i class="fa-solid fa-receipt text-sm"></i>`;
                }
                if (topTitle) {
                    topTitle.innerText = "Input Transaksi";
                }
                if (topBadge) {
                    topBadge.className = "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800";
                    topBadge.innerHTML = `<i class="fa-solid fa-circle-plus"></i> Input Baru`;
                }
                if (switchBtn) {
                    switchBtn.classList.add('hidden');
                    switchBtn.classList.remove('inline-flex');
                }
            }
        }

        function resetTransactionForm() {
            const form = document.getElementById('transactionForm');
            if (form) form.reset();

            const editId = document.getElementById('editReceiptId');
            if (editId) editId.value = '';

            updateFormReceiptPhotoDisplay('');

            const subtotalInp = document.getElementById('formSubtotalDisplay');
            if (subtotalInp) subtotalInp.value = '0';

            const discInp = document.getElementById('formDiscount');
            if (discInp) discInp.value = '0';

            const taxInp = document.getElementById('formTax');
            if (taxInp) taxInp.value = '0';

            const otherInp = document.getElementById('formOther');
            if (otherInp) otherInp.value = '0';

            const container = document.getElementById('formItemsContainer');
            if (container) container.innerHTML = '';
            state.formItemIndexCounter = 0;
            // Daftar barang opsional: tidak memunculkan baris baru secara default
            updateItemCountBadge();

            // Set default date to today
            const dateInput = document.getElementById('formDate');
            if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];

            // Sinkronkan kategori form dan aksen banner Mode Multi-Modul
            const formCatSelect = document.getElementById('formMasterCategorySelect');
            if (formCatSelect) {
                const targetCat = (state.activeMasterCategoryId && state.activeMasterCategoryId !== 'all') ? state.activeMasterCategoryId : 'all';
                formCatSelect.value = targetCat;
                handleFormCategoryChange(targetCat);
            }

            calculateFormGrandTotal(false);
            updateTransactionFormModeUI();
        }

        function handleTransactionSubmit(e) {
            e.preventDefault();

            const merchant = document.getElementById('formMerchant').value.trim();
            const date = document.getElementById('formDate').value;
            const subtotalInp = document.getElementById('formSubtotalDisplay');
            const subtotal = parseThousand(subtotalInp?.value);

            // Syarat Simpan Manual: Sistem hanya mewajibkan Toko, Tanggal, dan Subtotal
            if (!merchant) {
                showToast("Nama Toko / Merchant wajib diisi!", "warning");
                const mInp = document.getElementById('formMerchant');
                if (mInp) mInp.focus();
                return;
            }
            if (!date) {
                showToast("Tanggal transaksi wajib diisi!", "warning");
                const dInp = document.getElementById('formDate');
                if (dInp) dInp.focus();
                return;
            }
            if (!subtotal || subtotal <= 0) {
                showToast("Subtotal wajib diisi lebih dari 0!", "warning");
                if (subtotalInp) subtotalInp.focus();
                return;
            }

            const catId = document.getElementById('formMasterCategorySelect').value;
            const isMultiModule = catId === 'all';
            const multiConf = getMultiModuleConfig();
            const catObj = isMultiModule ? { id: 'all', name: multiConf.name || 'Multi-Modul', sheetName: 'DB_Multi', color: multiConf.color || '#10B981', icon: multiConf.icon || 'fa-layer-group' } : (state.masterCategories.find(c => c.id === catId) || state.masterCategories[0]);
            const receiptPhotoBase64 = document.getElementById('formReceiptPhotoBase64').value;
            const discount = parseThousand(document.getElementById('formDiscount')?.value);
            const tax = parseThousand(document.getElementById('formTax')?.value);
            const other = parseSignedThousand(document.getElementById('formOther')?.value);
            const editReceiptId = document.getElementById('editReceiptId').value.trim();

            const container = document.getElementById('formItemsContainer');
            const rows = container ? container.querySelectorAll('.item-row-box') : [];
            const items = [];

            if (rows.length > 0) {
                rows.forEach(r => {
                    let itemName = r.querySelector('.item-name-input')?.value.trim();
                    let subCategory = r.querySelector('.item-subcategory-select')?.value?.trim();
                    const qty = Number(r.querySelector('.item-qty-input')?.value) || 1;
                    const cost = parseThousand(r.querySelector('.item-cost-input')?.value);
                    const itemPhotoUrl = r.querySelector('.item-photo-base64')?.value || '';
                    const itemPhotoBase64 = itemPhotoUrl.includes('base64,') ? itemPhotoUrl.split('base64,')[1] : (itemPhotoUrl.startsWith('http') ? '' : itemPhotoUrl);
                    
                    // Kategori Default: Apabila tidak ada keterangan item maupun sub-kategori yang dipilih -> "Lainnya/Other"
                    if (!itemName) {
                        itemName = "Lainnya/Other";
                    }
                    if (!subCategory) {
                        subCategory = "Lainnya/Other";
                    }

                    let itemCatId = catObj.id;
                    let itemCatName = catObj.name;
                    let itemSheetName = catObj.sheetName;

                    if (isMultiModule) {
                        const selCat = r.querySelector('.item-category-select');
                        const cId = selCat ? selCat.value : state.masterCategories[0].id;
                        const cObj = state.masterCategories.find(c => c.id === cId) || state.masterCategories[0];
                        itemCatId = cObj.id;
                        itemCatName = cObj.name;
                        itemSheetName = cObj.sheetName;
                    }

                    items.push({ 
                        itemName, 
                        subCategory, 
                        qty, 
                        cost: cost > 0 ? cost : subtotal, 
                        itemPhotoUrl, 
                        itemPhotoBase64,
                        masterCategoryId: itemCatId,
                        masterCategoryName: itemCatName,
                        categorySheetName: itemSheetName,
                        sheetName: itemSheetName
                    });
                });
            }

            // Jika daftar barang kosong (karena opsional), buat 1 item default otomatis ke "Lainnya/Other"
            if (items.length === 0) {
                const targetCat = (catObj.id === 'all') ? (state.masterCategories[0] || { id: 'dapur', name: 'Belanja Dapur', sheetName: 'DB_Dapur' }) : catObj;
                items.push({
                    itemName: merchant,
                    subCategory: "Lainnya/Other",
                    qty: 1,
                    cost: subtotal,
                    itemPhotoUrl: '',
                    itemPhotoBase64: '',
                    masterCategoryId: targetCat.id,
                    masterCategoryName: targetCat.name,
                    categorySheetName: targetCat.sheetName,
                    sheetName: targetCat.sheetName
                });
            }

            // Alokasikan diskon, pajak, dan biaya lainnya secara proporsional per item (prorata adil)
            let remainingDiscount = discount;
            let remainingTax = tax;
            let remainingOther = other;
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                const itemTotal = (Number(it.cost) || 0) * (Number(it.qty) || 1);
                if (i === items.length - 1) {
                    it.discount = remainingDiscount;
                    it.tax = remainingTax;
                    it.other = remainingOther;
                } else {
                    const ratio = subtotal > 0 ? (itemTotal / subtotal) : (1 / items.length);
                    it.discount = Math.round(discount * ratio);
                    it.tax = Math.round(tax * ratio);
                    it.other = Math.round(other * ratio);
                    remainingDiscount -= it.discount;
                    remainingTax -= it.tax;
                    remainingOther -= it.other;
                }
            }

            const payload = {
                receiptId: editReceiptId || undefined,
                merchant: merchant,
                date: date,
                categorySheetName: catObj.sheetName,
                masterCategoryId: catObj.id,
                isMultiModule: isMultiModule,
                subtotal: subtotal,
                discount: discount,
                tax: tax,
                other: other,
                receiptPhotoBase64: receiptPhotoBase64,
                customSpreadsheetId: (state.currentUser && state.currentUser.customSpreadsheetId) || "",
                userId: (state.currentUser && state.currentUser.userId) || "",
                items: items
            };

            // ---------------- OPTIMISTIC UI UPDATE (INSTANT RESPONSE) ----------------
            const isEdit = !!editReceiptId;
            const tempReceiptId = editReceiptId || ("TEMP-" + Date.now());
            const grandTotal = Math.max(0, subtotal - discount + tax + other);

            // Simpan backup untuk rollback jika transmisi backend gagal
            const backupReceipts = [...state.receipts];
            const backupEntries = [...state.entries];

            const currentUserName = (state.currentUser && (state.currentUser.fullName || state.currentUser.username)) || "Saya";
            const optimisticReceipt = {
                receiptId: tempReceiptId,
                merchant: merchant,
                date: date,
                masterCategoryId: catObj.id,
                masterCategoryName: catObj.name,
                masterSheetName: catObj.sheetName,
                userId: (state.currentUser && state.currentUser.userId) || "",
                createdByName: currentUserName,
                totalAmount: grandTotal,
                subtotal: subtotal,
                totalCost: subtotal,
                discount: discount,
                tax: tax,
                other: other,
                totalDiscount: discount,
                totalTax: tax,
                totalOther: other,
                itemsCount: items.length,
                receiptPhotoUrl: receiptPhotoBase64 ? (receiptPhotoBase64.startsWith('data:') ? receiptPhotoBase64 : 'data:image/jpeg;base64,' + receiptPhotoBase64) : '',
                items: items.map(it => ({
                    receiptId: tempReceiptId,
                    date: date,
                    merchant: merchant,
                    itemName: it.itemName,
                    subCategory: it.subCategory,
                    qty: it.qty,
                    cost: it.cost,
                    totalCost: it.cost * it.qty,
                    discount: it.discount || 0,
                    tax: it.tax || 0,
                    other: it.other || 0,
                    masterCategoryId: it.masterCategoryId || catObj.id,
                    masterCategoryName: it.masterCategoryName || catObj.name,
                    masterSheetName: it.categorySheetName || catObj.sheetName,
                    sheetName: it.categorySheetName || catObj.sheetName,
                    itemPhotoUrl: it.itemPhotoUrl || '',
                    userId: (state.currentUser && state.currentUser.userId) || "",
                    createdByName: currentUserName
                }))
            };

            const optimisticEntries = optimisticReceipt.items;

            if (isEdit) {
                state.receipts = state.receipts.map(r => r.receiptId === editReceiptId ? optimisticReceipt : r);
                state.entries = state.entries.filter(e => e.receiptId !== editReceiptId).concat(optimisticEntries);
            } else {
                state.receipts = [optimisticReceipt, ...state.receipts];
                state.entries = [...optimisticEntries, ...state.entries];
            }

            // Update UI seketika tanpa menunggu server (0ms latency feel)
            resetTransactionForm();
            setAppMode('history');
            showToast(isEdit ? "Perubahan disimpan (menyinkronkan ke Cloud...)" : "Transaksi dicatat (menyinkronkan ke Cloud...)", "info", 2500);

            // Eksekusi transmisi ke backend di latar belakang (non-blocking)
            if (typeof google !== 'undefined' && google.script && google.script.run) {
                if (isEdit) {
                    google.script.run
                        .withSuccessHandler(function(resp) {
                            if (resp && resp.success) {
                                showToast("Perubahan tersinkronisasi ke Google Sheets!", "success");
                            } else {
                                rollbackOptimistic(backupReceipts, backupEntries, resp ? resp.message : "Gagal memperbarui");
                            }
                        })
                        .withFailureHandler(function(err) {
                            rollbackOptimistic(backupReceipts, backupEntries, err.message || err);
                        })
                        .updateTransactionInSheet(catObj.sheetName, payload);
                } else {
                    google.script.run
                        .withSuccessHandler(function(resp) {
                            if (resp && resp.success) {
                                const realId = resp.receiptId;
                                if (realId && realId !== tempReceiptId) {
                                    // Ganti temp ID dengan ID permanen dari backend
                                    state.receipts.forEach(r => {
                                        if (r.receiptId === tempReceiptId) {
                                            r.receiptId = realId;
                                            if (r.items) r.items.forEach(it => it.receiptId = realId);
                                        }
                                    });
                                    state.entries.forEach(e => {
                                        if (e.receiptId === tempReceiptId) e.receiptId = realId;
                                    });
                                    filterHistoryList();
                                }
                                showToast("Transaksi tersimpan di Google Sheets!", "success");
                            } else {
                                rollbackOptimistic(backupReceipts, backupEntries, resp ? resp.message : "Gagal menyimpan");
                            }
                        })
                        .withFailureHandler(function(err) {
                            rollbackOptimistic(backupReceipts, backupEntries, err.message || err);
                        })
                        .saveTransactionToSheet(catObj.sheetName, payload);
                }
            } else {
                // Standalone / Local Simulation Mode
                setTimeout(() => {
                    saveMockData(state.entries, state.receipts);
                    showToast(isEdit ? "Perubahan berhasil disimpan (Mode Demo)" : "Transaksi berhasil dicatat (Mode Demo)", "success");
                }, 300);
            }
        }

        function rollbackOptimistic(backupReceipts, backupEntries, errorMsg) {
            state.receipts = backupReceipts;
            state.entries = backupEntries;
            renderDashboard();
            filterHistoryList();
            showToast("Sinkronisasi gagal: " + errorMsg, "error", 5000);
        }

        function onSubmitError(err) {
            const submitBtn = document.getElementById('btnSubmitForm');
            if (submitBtn) {
                submitBtn.disabled = false;
            }
            updateTransactionFormModeUI();
            showToast("Kesalahan sistem: " + (err.message || err));
        }

        /* ---------------- PEMINDAI STRUK CERDAS: AI, HYBRID & OCR LOKAL ---------------- */
        let currentScanMethod = 'full_ai'; // Default 'full_ai' | 'hybrid' | 'local'
        let currentFile = null;
        let currentBase64 = null;
        let currentMimeType = null;

        function switchScannerMethod(method) {
            currentScanMethod = method;
            const tabFull = document.getElementById('tabMethodFull');
            const tabHybrid = document.getElementById('tabMethodHybrid');
            const tabLocal = document.getElementById('tabMethodLocal');
            const noticeText = document.getElementById('methodNoticeText');
            const btnExecuteText = document.getElementById('btnExecuteText');
            const logTypeBadge = document.getElementById('logTypeBadge');

            const inactiveClass = "px-2.5 py-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-main)] transition";
            const activeClass = "px-2.5 py-1 rounded-lg bg-[var(--bg-surface)] text-[var(--text-main)] shadow-xs font-bold transition";

            if (tabFull) tabFull.className = inactiveClass;
            if (tabHybrid) tabHybrid.className = inactiveClass;
            if (tabLocal) tabLocal.className = inactiveClass;

            if (method === 'full_ai') {
                if (tabFull) tabFull.className = activeClass;
                if (btnExecuteText) btnExecuteText.innerHTML = "Pindai Sekarang (Full AI)";
                if (noticeText) noticeText.innerHTML = "<strong>Metode Full AI:</strong> Mengirim dokumen visual struk (PDF/Foto) langsung ke Gemini Vision.";
                if (logTypeBadge) {
                    logTypeBadge.textContent = "Full AI Vision";
                    logTypeBadge.className = "text-[10px] font-semibold px-2 py-0.5 rounded bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300";
                }
            } else if (method === 'hybrid') {
                if (tabHybrid) tabHybrid.className = activeClass;
                if (btnExecuteText) btnExecuteText.innerHTML = "Pindai Sekarang (Hybrid)";
                if (noticeText) noticeText.innerHTML = "<strong>Metode Hybrid:</strong> Mengekstrak teks dengan OCR lokal &rarr; kirim teks ringkas ke AI untuk hemat token & kuota.";
                if (logTypeBadge) {
                    logTypeBadge.textContent = "Hybrid: OCR -> AI";
                    logTypeBadge.className = "text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300";
                }
            } else {
                if (tabLocal) tabLocal.className = activeClass;
                if (btnExecuteText) btnExecuteText.innerHTML = "Ekstrak dengan OCR Lokal (Offline)";
                if (noticeText) noticeText.innerHTML = "<strong>Metode OCR Lokal:</strong> Menggunakan OCR Tesseract / PDF.js + Heuristik Regex (100% offline).";
                if (logTypeBadge) {
                    logTypeBadge.textContent = "100% OCR Lokal";
                    logTypeBadge.className = "text-[10px] font-semibold px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200";
                }
            }
        }

        function handleReceiptFileSelected(e) {
            if (e.target.files && e.target.files[0]) {
                handleFileSelected(e.target.files[0]);
            }
        }

        function handleFileSelected(file) {
            currentFile = file;
            currentBase64 = null;

            const nameEl = document.getElementById('fileName');
            const sizeEl = document.getElementById('fileSize');
            const iconEl = document.getElementById('fileIcon');
            const infoBox = document.getElementById('fileInfoBox');
            const previewBox = document.getElementById('imagePreviewBox');
            const previewImg = document.getElementById('imagePreview');

            if (nameEl) nameEl.textContent = file.name;
            if (sizeEl) sizeEl.textContent = (file.size / 1024).toFixed(1) + ' KB';
            if (infoBox) infoBox.classList.remove('hidden');

            const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
            currentMimeType = file.type || (isPdf ? 'application/pdf' : 'image/jpeg');

            if (isPdf) {
                if (iconEl) iconEl.className = 'fa-solid fa-file-pdf text-rose-500 text-lg';
                if (previewBox) previewBox.classList.add('hidden');
            } else {
                if (iconEl) iconEl.className = 'fa-solid fa-file-image text-purple-500 text-lg';
                if (previewImg && previewBox) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        previewImg.src = e.target.result;
                        currentBase64 = e.target.result;
                        previewBox.classList.remove('hidden');
                    };
                    reader.readAsDataURL(file);
                }
            }

            hideScanError();
            showToast("Berkas struk siap dipindai: " + file.name);
        }

        function handleModelChange(val) {
            safeStorage.setItem('saturuma_ai_model', val);
            const badge = document.getElementById('activeModelBadge');
            if (badge) badge.innerText = "Model: " + val;
            showToast("Model AI aktif: " + val);
        }

        function showProgress(text, pct) {
            const box = document.getElementById('scanProgress');
            const stepText = document.getElementById('progressStepText');
            const pctText = document.getElementById('progressPercent');
            const bar = document.getElementById('progressBar');

            if (box) box.classList.remove('hidden');
            if (stepText) stepText.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin text-purple-600 mr-1.5"></i> ${text}`;
            if (pctText) pctText.textContent = pct + '%';
            if (bar) bar.style.width = pct + '%';
        }

        function hideProgress() {
            const box = document.getElementById('scanProgress');
            if (box) box.classList.add('hidden');
        }

        function showScanError(title, message) {
            const box = document.getElementById('scanErrorBox');
            const t = document.getElementById('scanErrorTitle');
            const m = document.getElementById('scanErrorMessage');

            if (t) t.textContent = title;
            if (m) m.innerHTML = message;
            if (box) box.classList.remove('hidden');
            hideProgress();
        }

        function hideScanError() {
            const box = document.getElementById('scanErrorBox');
            if (box) box.classList.add('hidden');
        }

        function copyRawLog() {
            const log = document.getElementById('rawDebugLog');
            if (log && log.value) {
                navigator.clipboard.writeText(log.value);
                showToast("Teks berhasil disalin ke clipboard!");
            }
        }

        function clearRawLog() {
            const log = document.getElementById('rawDebugLog');
            if (log) {
                log.value = '';
                showToast("Teks ekstraksi dibersihkan.");
            }
        }

        /* ---------------- EKSEKUSI PEMINDAIAN STRUK ---------------- */
        async function executeScan() {
            const rawLog = document.getElementById('rawDebugLog');
            if (!currentFile && (!rawLog || rawLog.value.trim() === '')) {
                showScanError("Berkas Belum Dipilih", "Silakan unggah dokumen PDF / Foto struk, atau pilih salah satu tombol Preset di atas.");
                return;
            }

            hideScanError();
            const btn = document.getElementById('btnExecuteScan');
            if (btn) btn.disabled = true;

            try {
                if (currentScanMethod === 'full_ai') {
                    await executeFullAiScan();
                } else if (currentScanMethod === 'hybrid') {
                    await executeHybridScan();
                } else {
                    await executeLocalOcrScan();
                }
            } catch (err) {
                console.error("Scan error:", err);
                showScanError("Gagal Memproses", err.message || err);
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        /* 1. METODE FULL AI VISION */
        async function executeFullAiScan() {
            showProgress('Mempersiapkan visual dokumen untuk AI...', 25);
            const rawLog = document.getElementById('rawDebugLog');

            if (!currentBase64 && currentFile) {
                currentBase64 = await readFileAsBase64Async(currentFile);
            }

            if (!currentBase64 && rawLog && rawLog.value.trim() !== '') {
                // Jika input berasal dari preset teks
                await executeHybridScan();
                return;
            }

            showProgress('Mengirim ke Gemini Vision AI (multi-item, diskon, pajak)...', 55);

            const apiKey = safeStorage.getItem('saturuma_gemini_key') || localStorage.getItem('BABYNEST_DEMO_GEMINI_KEY') || localStorage.getItem('babynest_gemini_key') || '';
            const model = normalizeGeminiModelName(document.getElementById('scannerAiModelSelect')?.value || safeStorage.getItem('saturuma_ai_model') || 'gemini-3.5-flash-lite');

            const payload = {
                base64Data: currentBase64,
                mimeType: currentMimeType || 'image/jpeg',
                userApiKey: apiKey,
                aiModel: model
            };

            if (typeof google !== 'undefined' && google.script && google.script.run) {
                google.script.run
                    .withSuccessHandler(function(resp) {
                        hideProgress();
                        if (resp && resp.success && resp.data) {
                            if (rawLog) rawLog.value = JSON.stringify(resp.data, null, 2);
                            applyExtractedDataToForm(resp.data, `Full AI Vision (${resp.usedModel || model})`);
                        } else {
                            showScanError("Gagal Ekstraksi AI", resp ? resp.message : "Hasil kosong");
                        }
                    })
                    .withFailureHandler(function(err) {
                        hideProgress();
                        showScanError("Google Apps Script Error", err.message || err);
                    })
                    .extractReceiptWithAI(payload);
            } else {
                // Client-side Direct API Call jika standalone
                if (apiKey && apiKey.length > 10) {
                    await callGeminiApiDirectlyAsync(apiKey, currentBase64, currentMimeType, model);
                } else {
                    showProgress('Simulasi Ekstraksi AI Cerdas...', 85);
                    setTimeout(() => {
                        hideProgress();
                        const mockData = generateRealisticHouseholdExtraction();
                        if (rawLog) rawLog.value = JSON.stringify(mockData, null, 2);
                        applyExtractedDataToForm(mockData, "Full AI Vision (Demo)");
                    }, 1000);
                }
            }
        }

        /* 2. METODE HYBRID (OCR LOKAL -> AI TEXT) */
        async function executeHybridScan() {
            showProgress('Tahap 1: Mengekstrak teks struk dengan OCR lokal presisi...', 25);
            const rawLog = document.getElementById('rawDebugLog');
            let extractedText = '';

            if (currentFile) {
                if (currentFile.type === 'application/pdf' || currentFile.name.toLowerCase().endsWith('.pdf')) {
                    extractedText = await extractPdfLinesAccurate(currentFile);
                } else {
                    extractedText = await extractTesseractOcr(currentFile);
                }
            } else if (rawLog && rawLog.value.trim() !== '') {
                extractedText = rawLog.value;
            }

            // AUTO-FALLBACK CERDAS:
            // Jika hasil OCR terlalu pendek (< 25 karakter) atau foto struk sangat buram/faded,
            // otomatis alihkan ke Gemini Vision (Full AI) agar pengguna tidak gagal!
            const apiKey = safeStorage.getItem('saturuma_gemini_key') || localStorage.getItem('BABYNEST_DEMO_GEMINI_KEY') || localStorage.getItem('babynest_gemini_key') || '';
            const isOcrTooWeak = !extractedText || extractedText.trim().length < 25;

            if (isOcrTooWeak && currentFile && apiKey) {
                showProgress("Teks struk minim/pudar. Mengalihkan otomatis ke Gemini Vision...", 40);
                await executeFullAiScan();
                return;
            }

            if (!extractedText || !extractedText.trim()) {
                hideProgress();
                showScanError("Teks Tidak Ditemukan", "Gagal mengekstrak teks dari berkas struk. Silakan coba unggah foto yang lebih terang atau gunakan metode Full AI.");
                return;
            }

            if (rawLog) rawLog.value = "--- TEKS HASIL EKSTRAKSI OCR ---\n" + extractedText;
            showProgress('Tahap 2: AI merekonstruksi ejaan & memilah barang...', 65);

            const model = normalizeGeminiModelName(document.getElementById('scannerAiModelSelect')?.value || safeStorage.getItem('saturuma_ai_model') || 'gemini-3.5-flash-lite');

            const payload = {
                textData: extractedText,
                userApiKey: apiKey,
                aiModel: model
            };

            if (typeof google !== 'undefined' && google.script && google.script.run) {
                google.script.run
                    .withSuccessHandler(function(resp) {
                        hideProgress();
                        if (resp && resp.success && resp.data) {
                            if (rawLog) rawLog.value += "\n\n--- HASIL PARSING AI ---\n" + JSON.stringify(resp.data, null, 2);
                            applyExtractedDataToForm(resp.data, `Hybrid: OCR -> AI (${resp.usedModel || model})`);
                        } else {
                            const localParsed = runAdvancedSmartEngine(extractedText);
                            applyExtractedDataToForm(localParsed, "Hybrid Fallback: Regex");
                        }
                    })
                    .withFailureHandler(function(err) {
                        hideProgress();
                        const localParsed = runAdvancedSmartEngine(extractedText);
                        applyExtractedDataToForm(localParsed, "Hybrid Fallback: Regex");
                    })
                    .extractReceiptWithAI(payload);
            } else {
                if (apiKey && apiKey.length > 10) {
                    await callGeminiTextPromptAsync(apiKey, extractedText, model);
                } else {
                    setTimeout(() => {
                        hideProgress();
                        const localParsed = runAdvancedSmartEngine(extractedText);
                        if (rawLog) rawLog.value += "\n\n--- HASIL PARSING HEURISTIK LOKAL ---\n" + JSON.stringify(localParsed, null, 2);
                        applyExtractedDataToForm(localParsed, "Hybrid Pipeline (Simulasi)");
                    }, 800);
                }
            }
        }

        /* 3. METODE OCR LOKAL (100% OFFLINE) */
        async function executeLocalOcrScan() {
            showProgress('Menjalankan OCR lokal (100% Offline)...', 35);
            const rawLog = document.getElementById('rawDebugLog');
            let text = '';

            if (currentFile) {
                if (currentFile.type === 'application/pdf' || currentFile.name.toLowerCase().endsWith('.pdf')) {
                    text = await extractPdfLinesAccurate(currentFile);
                } else {
                    text = await extractTesseractOcr(currentFile);
                }
            } else if (rawLog && rawLog.value.trim() !== '') {
                text = rawLog.value;
            }

            if (!text || !text.trim()) {
                hideProgress();
                showScanError("OCR Kosong", "Teks tidak dapat dibaca dari dokumen.");
                return;
            }

            showProgress('Menganalisis pola teks, harga, diskon & pajak...', 75);
            if (rawLog) rawLog.value = text;

            const smartResult = runAdvancedSmartEngine(text);
            hideProgress();
            applyExtractedDataToForm(smartResult, '100% OCR Lokal (Regex Heuristik)');
        }

        /* HELPER: BACA PDF.JS SECARA AKURAT DENGAN FALLBACK SCAN-TO-CANVAS OCR */
        async function extractPdfLinesAccurate(file) {
            try {
                const arrayBuffer = await file.arrayBuffer();
                const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                let fullText = '';

                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const textContent = await page.getTextContent();
                    const items = textContent.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
                    items.sort((a, b) => b.y - a.y || a.x - b.x);

                    const lines = [];
                    let currentLine = [];
                    let lastY = null;

                    for (let it of items) {
                        if (lastY === null || Math.abs(it.y - lastY) < 5) currentLine.push(it);
                        else {
                            currentLine.sort((a, b) => a.x - b.x);
                            lines.push(currentLine.map(t => t.str).join(' '));
                            currentLine = [it];
                        }
                        lastY = it.y;
                    }
                    if (currentLine.length > 0) {
                        currentLine.sort((a, b) => a.x - b.x);
                        lines.push(currentLine.map(t => t.str).join(' '));
                    }
                    fullText += lines.join('\n') + '\n';
                }

                // Fallback untuk Scanned PDF (PDF berupa foto scan tanpa layer teks vektor)
                if (fullText.trim().length < 25 && pdf.numPages >= 1) {
                    showProgress("PDF berupa gambar scan. Merender halaman untuk OCR resolusi tinggi...", 35);
                    const page1 = await pdf.getPage(1);
                    const viewport = page1.getViewport({ scale: 2.0 });
                    const canvas = document.createElement('canvas');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    const ctx = canvas.getContext('2d');
                    await page1.render({ canvasContext: ctx, viewport: viewport }).promise;
                    fullText = await extractTesseractOcr(canvas);
                }

                return fullText;
            } catch (err) {
                console.error("PDF.js extract error:", err);
                return "";
            }
        }

        /* HELPER: TESSERACT.JS OCR */
        async function extractTesseractOcr(fileOrCanvas) {
            if (typeof Tesseract === 'undefined') {
                throw new Error("Modul Tesseract.js belum dimuat.");
            }

            const worker = await Tesseract.createWorker('ind', 1, {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        const pct = Math.round(m.progress * 100);
                        showProgress(`Mengenali karakter teks (OCR: ${pct}%)...`, 30 + Math.round(pct * 0.4));
                    }
                }
            });

            const ret = await worker.recognize(fileOrCanvas);
            await worker.terminate();
            return ret.data.text || "";
        }

        function readFileAsBase64Async(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }

        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        /* RESILIENT GEMINI CALLER WITH BACKOFF & CANDIDATE MODELS (DARI TEST_OCR.HTML) */
        async function callGeminiWithCandidateFallbacks(apiKey, requestBody, preferredModel) {
            const candidateModels = [
                preferredModel,
                "gemini-3.5-flash-lite",
                "gemini-2.5-flash",
                "gemini-3.5-flash",
                "gemini-2.5-flash-lite",
                "gemini-2.0-flash",
                "gemini-2.0-flash-lite"
            ];
            const uniqueModels = [...new Set(candidateModels.filter(Boolean).map(m => normalizeGeminiModelName(m)))];

            let lastError = null;
            let quotaExhaustedCount = 0;

            for (let i = 0; i < uniqueModels.length; i++) {
                const m = uniqueModels[i];
                const maxRetries = 2;
                let backoffDelayMs = 2500;

                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    const stepPct = 30 + Math.round((i / uniqueModels.length) * 55) + (attempt > 1 ? 5 : 0);
                    showProgress(`Menghubungkan ke ${m} (Percobaan ${attempt}/${maxRetries})...`, stepPct);

                    try {
                        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
                        const res = await fetch(apiUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(requestBody)
                        });

                        if (res.ok) {
                            const json = await res.json();
                            const candidate = json.candidates && json.candidates[0];
                            if (candidate && candidate.content && candidate.content.parts) {
                                let text = "";
                                for (let p of candidate.content.parts) {
                                    if (p.text && !p.thought) { text = p.text; break; }
                                }
                                if (!text && candidate.content.parts.length > 0) text = candidate.content.parts[candidate.content.parts.length - 1].text || "";
                                return { success: true, text: text, usedModel: m };
                            }
                        } else if (res.status === 429) {
                            quotaExhaustedCount++;
                            const errBody = await res.text();
                            lastError = `HTTP 429 pada ${m}: ${errBody}`;
                            if (attempt < maxRetries) {
                                showProgress(`[429 Rate Limit] Model ${m} sibuk. Jeda ${(backoffDelayMs/1000).toFixed(1)}s...`, stepPct);
                                await delay(backoffDelayMs);
                                backoffDelayMs *= 1.5;
                            } else {
                                showProgress(`[429 Kuota] Beralih model cadangan dalam 2s...`, stepPct);
                                await delay(2000);
                            }
                        } else if (res.status === 404) {
                            console.warn(`Model ${m} 404, lanjut ke model berikutnya...`);
                            lastError = `Model ${m} 404`;
                            break;
                        } else {
                            const errText = await res.text();
                            lastError = `Error (${res.status}) pada ${m}: ${errText}`;
                            if (res.status === 400 || res.status === 401 || res.status === 403) {
                                return { success: false, error: lastError, isAuthError: true, statusCode: res.status };
                            }
                            if (res.status === 503 && attempt < maxRetries) await delay(2000);
                            else break;
                        }
                    } catch (fetchErr) {
                        lastError = fetchErr.message;
                        await delay(1500);
                    }
                }
            }
            return { success: false, error: lastError, isQuotaExhausted: quotaExhaustedCount > 0, statusCode: quotaExhaustedCount > 0 ? 429 : 500 };
        }

        /* HELPER: CALL GEMINI DIRECTLY DENGAN CANDIDATE FALLBACKS (DARI TEST_OCR.HTML) */
        async function callGeminiApiDirectlyAsync(apiKey, base64Data, mimeType, modelName) {
            let rawData = base64Data;
            let mType = mimeType || "image/jpeg";
            if (rawData.indexOf('data:') === 0) {
                const parts = rawData.split(',');
                const meta = parts[0];
                rawData = parts[1];
                const m = meta.match(/:(.*?);/);
                if (m && m[1]) mType = m[1];
            }

            const preferredModel = normalizeGeminiModelName(modelName);

            const systemPrompt = `Anda adalah asisten AI akuntansi pengeluaran keluarga Saturuma.
Baca foto struk / nota belanja / PDF invoice ini dengan teliti.
STRUK BISA BERISI BANYAK BARANG (MULTI-ITEM), DISKON, DAN PAJAK.

KATALOG MODUL & SUBKATEGORI SATURUMA:
- "dapur" (Belanja Dapur & Groceries): Sembako & Bumbu, Sayur & Buah, Daging & Ikan, Makanan Instan & Camilan, Minuman, Alat Dapur, Perlengkapan Cuci
- "bayi" (Kebutuhan Bayi): Popok, Susu & Makanan, Pakaian, Kesehatan & Mandi, Gear & Perlengkapan, Mainan & Buku, Lainnya
- "tagihan" (Tagihan & Rutinitas Rumah): Listrik PLN, Air PDAM, Internet & WiFi, Gas Elpiji, Iuran RT/RW & Keamanan, Sampah & Kebersihan, Cicilan & Sewa
- "transport" (Transportasi & Kendaraan): Bensin & BBM, Tol & Parkir, Servis & Oli, Pajak & STNK, Angkutan Umum / Ojol, Cuci Kendaraan, Sparepart
- "tabungan" (Tabungan & Investasi): Dana Darurat, Tabungan Pendidikan, Emas & Logam Mulia, Reksadana & Saham, Asuransi, Tabungan Khusus

ATURAN PENTING:
1. JANGAN memasukkan baris diskon, promo, hemat, atau pajak sebagai barang di array "items".
2. Tentukan untuk setiap barang: "masterCategoryId" (pilih ID modul di atas) dan "subCategory" (pilih nama subkategori di atas yang paling tepat).
3. "suggestedMasterCategoryId": ID modul utama struk ini (misal: 'dapur', 'bayi', 'tagihan', 'transport').
4. Identifikasi diskon (angka positif), pajak/PPN (angka positif), subtotal, dan grandTotal.
5. Biaya Lainnya ("other"): Biaya di luar diskon & pajak (misal: biaya admin/layanan, kantong plastik, ongkir, pembulatan kasir). Angka positif jika menambah total, negatif jika mengurangi, 0 jika tidak ada. JANGAN masukkan sebagai item barang.
Format JSON valid murni:
{
  "merchant": "Nama Toko / Merchant",
  "date": "YYYY-MM-DD",
  "suggestedMasterCategoryId": "dapur",
  "items": [
    {
      "itemName": "Nama Barang",
      "masterCategoryId": "dapur",
      "subCategory": "Sembako & Bumbu",
      "qty": 1,
      "cost": 50000
    }
  ],
  "subtotal": 50000,
  "discount": 0,
  "tax": 0,
  "other": 0,
  "grandTotal": 50000
}`;

            const requestBody = {
                contents: [{
                    role: "user",
                    parts: [
                        { text: systemPrompt },
                        { inlineData: { mimeType: mType, data: rawData } }
                    ]
                }],
                generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
            };

            const apiResult = await callGeminiWithCandidateFallbacks(apiKey, requestBody, preferredModel);

            if (apiResult.success) {
                const rawLog = document.getElementById('rawDebugLog');
                if (rawLog) rawLog.value = apiResult.text;
                try {
                    let cleanJson = apiResult.text.trim();
                    if (cleanJson.includes('```')) cleanJson = cleanJson.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
                    const parsed = JSON.parse(cleanJson);
                    applyExtractedDataToForm(parsed, `Full AI (${apiResult.usedModel})`);
                    showProgress(`Selesai dengan ${apiResult.usedModel}!`, 100);
                    setTimeout(hideProgress, 500);
                } catch (parseErr) {
                    hideProgress();
                    showScanError("Format JSON Gagal", "Gagal memproses JSON AI: " + parseErr.message);
                }
            } else {
                hideProgress();
                const rawLog = document.getElementById('rawDebugLog');
                if (rawLog) rawLog.value = "=== LOG ERROR API ===\n" + (apiResult.error || "Gagal memproses API");
                if (apiResult.isQuotaExhausted || apiResult.statusCode === 429) {
                    showScanError("Batas Kuota Permintaan Habis (HTTP 429)", "Batas kuota harian (RPD) Google AI Studio habis untuk semua candidate model. Silakan gunakan API Key baru atau tunggu reset kuota.");
                } else if (apiResult.isAuthError) {
                    showScanError(`Otentikasi Gagal (HTTP ${apiResult.statusCode})`, "Kunci API Google Gemini tidak valid. Silakan periksa di menu Pengaturan.");
                } else {
                    showScanError("Gagal Ekstraksi AI", apiResult.error || "Kesalahan saat memanggil AI.");
                }
            }
        }

        async function callGeminiTextPromptAsync(apiKey, rawText, modelName) {
            const preferredModel = normalizeGeminiModelName(modelName);
            const prompt = `Anda adalah asisten AI akuntansi rumah tangga Saturuma yang cerdas dan teliti.
Teks berikut merupakan hasil ekstraksi OCR dari struk belanja fisik/kamera.

TUGAS UTAMA:
1. REKONSTRUKSI EJAAN OCR: Koreksi karakter yang sering tertukar pada struk (misal: 'O'/'D' tertukar '0', 'I'/'l' tertukar '1', 'S' tertukar '5', 'B' tertukar '8').
2. NORMALISASI SINGKATAN KASIR: Ubah singkatan kasir menjadi nama barang yang wajar dan jelas (misal: 'MYPK' -> 'MamyPoko', 'SWTY' -> 'Sweety', 'ZWTSL' -> 'Zwitsal', 'MYK TELON' -> 'Minyak Telon', 'BMS' -> 'Bimoli', 'SGM EKS' -> 'SGM Eksplor').
3. Identifikasi Nama Toko/Merchant, Tanggal (format YYYY-MM-DD), daftar barang belanja, kuantitas (qty), dan harga (cost).
4. JANGAN memasukkan baris diskon, promo, atau pajak sebagai nama barang di array "items".
5. Identifikasi diskon (angka positif) dan pajak (angka positif).
6. Biaya Lainnya ("other"): Biaya di luar diskon & pajak (misal: biaya admin/layanan, kantong plastik, ongkir, pembulatan kasir). Angka positif jika menambah total, negatif jika mengurangi, 0 jika tidak ada. JANGAN masukkan sebagai item barang.
7. Tentukan untuk setiap barang: "masterCategoryId" dan "subCategory" sesuai katalog Saturuma di bawah:

KATALOG MODUL & SUBKATEGORI SATURUMA:
- "dapur" (Belanja Dapur & Groceries): Sembako & Bumbu, Sayur & Buah, Daging & Ikan, Makanan Instan & Camilan, Minuman, Alat Dapur, Perlengkapan Cuci
- "bayi" (Kebutuhan Bayi): Popok, Susu & Makanan, Pakaian, Kesehatan & Mandi, Gear & Perlengkapan, Mainan & Buku, Lainnya
- "tagihan" (Tagihan & Rutinitas Rumah): Listrik PLN, Air PDAM, Internet & WiFi, Gas Elpiji, Iuran RT/RW & Keamanan, Sampah & Kebersihan, Cicilan & Sewa
- "transport" (Transportasi & Kendaraan): Bensin & BBM, Tol & Parkir, Servis & Oli, Pajak & STNK, Angkutan Umum / Ojol, Cuci Kendaraan, Sparepart
- "tabungan" (Tabungan & Investasi): Dana Darurat, Tabungan Pendidikan, Emas & Logam Mulia, Reksadana & Saham, Asuransi, Tabungan Khusus

Format JSON valid:
{
  "merchant": "Nama Toko",
  "date": "YYYY-MM-DD",
  "suggestedMasterCategoryId": "dapur",
  "items": [{ "itemName": "Nama Barang", "masterCategoryId": "dapur", "subCategory": "Sembako & Bumbu", "qty": 1, "cost": 50000 }],
  "subtotal": 50000,
  "discount": 0,
  "tax": 0,
  "other": 0,
  "grandTotal": 50000
}
TEKS HASIL OCR STRUK:
${rawText}`;

            const requestBody = {
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
            };

            const apiResult = await callGeminiWithCandidateFallbacks(apiKey, requestBody, preferredModel);

            if (apiResult.success) {
                const rawLog = document.getElementById('rawDebugLog');
                if (rawLog) rawLog.value += "\n\n--- HASIL JSON AI ---\n" + apiResult.text;
                try {
                    let cleanJson = apiResult.text.trim();
                    if (cleanJson.includes('```')) cleanJson = cleanJson.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
                    const parsed = JSON.parse(cleanJson);
                    applyExtractedDataToForm(parsed, `Hybrid: OCR -> ${apiResult.usedModel}`);
                    showProgress(`Selesai dengan ${apiResult.usedModel}!`, 100);
                    setTimeout(hideProgress, 500);
                } catch (e) {
                    hideProgress();
                    const localParsed = runAdvancedSmartEngine(rawText);
                    applyExtractedDataToForm(localParsed, "Hybrid Fallback: Regex");
                }
            } else {
                hideProgress();
                const localParsed = runAdvancedSmartEngine(rawText);
                applyExtractedDataToForm(localParsed, "Hybrid Fallback: Regex");
            }
        }

        /* DATE PARSING & SANITIZATION UTILITIES (DARI TEST_OCR.HTML) */
        function extractSmartDate(text) {
            if (!text) return new Date().toISOString().split('T')[0];

            // 1. Textual Month Format (e.g., "03 Nov 2026", "3 November 2026", "05-Nov-26")
            const monthMap = {
                jan: '01', januari: '01', january: '01',
                feb: '02', februari: '02', february: '02',
                mar: '03', maret: '03', march: '03',
                apr: '04', april: '04',
                mei: '05', may: '05',
                jun: '06', juni: '06', june: '06',
                jul: '07', juli: '07', july: '07',
                agu: '08', ags: '08', agust: '08', agustus: '08', aug: '08', august: '08',
                sep: '09', sept: '09', september: '09',
                okt: '10', oct: '10', oktober: '10', october: '10',
                nov: '11', nop: '11', nopember: '11', november: '11',
                des: '12', dec: '12', desember: '12', december: '12'
            };
            const textMonthMatch = text.match(/\b(\d{1,2})[\s\/\.-]+([a-zA-Z]{3,9})[\s\/\.-]+(20\d{2}|\d{2})\b/i);
            if (textMonthMatch) {
                const mKey = textMonthMatch[2].toLowerCase();
                if (monthMap[mKey]) {
                    let d = parseInt(textMonthMatch[1], 10);
                    let m = monthMap[mKey];
                    let y = textMonthMatch[3].length === 2 ? '20' + textMonthMatch[3] : textMonthMatch[3];
                    if (d >= 1 && d <= 31) {
                        return `${y}-${m}-${String(d).padStart(2, '0')}`;
                    }
                }
            }

            // 2. ISO Format (e.g., 2026-11-03 or 2026/11/03)
            const isoMatch = text.match(/\b(20\d{2})[\/\.-](\d{1,2})[\/\.-](\d{1,2})\b/);
            if (isoMatch) {
                let y = isoMatch[1];
                let m = parseInt(isoMatch[2], 10);
                let d = parseInt(isoMatch[3], 10);
                if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            // 3. Glued time with OCR noise, e.g. "03-11-268:30" (year 26 + hour 8)
            const gluedMatch = text.match(/\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2})\d(?::\d{2})/);
            if (gluedMatch) {
                let d = parseInt(gluedMatch[1], 10);
                let m = parseInt(gluedMatch[2], 10);
                let y = '20' + gluedMatch[3];
                if (m > 12 && d <= 12) { const tmp = d; d = m; m = tmp; }
                if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            // 4. Standard DD/MM/YYYY or DD-MM-YYYY (4-digit year)
            const dmy4Match = text.match(/\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](20\d{2})\b/);
            if (dmy4Match) {
                let d = parseInt(dmy4Match[1], 10);
                let m = parseInt(dmy4Match[2], 10);
                let y = dmy4Match[3];
                if (m > 12 && d <= 12) { const tmp = d; d = m; m = tmp; }
                if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            // 5. Standard DD/MM/YY or DD-MM-YY (2-digit year)
            const dmy2Match = text.match(/\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2})(?!\d)/);
            if (dmy2Match) {
                let d = parseInt(dmy2Match[1], 10);
                let m = parseInt(dmy2Match[2], 10);
                let y = '20' + dmy2Match[3];
                if (m > 12 && d <= 12) { const tmp = d; d = m; m = tmp; }
                if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            // 6. Fallback check for 3-digit year OCR artifact like "03-11-268" -> treat first 2 digits as 2-digit year (e.g. 26 -> 2026)
            const artifact3Match = text.match(/\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{3})\b/);
            if (artifact3Match) {
                let d = parseInt(artifact3Match[1], 10);
                let m = parseInt(artifact3Match[2], 10);
                let yPart = artifact3Match[3].substring(0, 2);
                let y = '20' + yPart;
                if (m > 12 && d <= 12) { const tmp = d; d = m; m = tmp; }
                if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            return new Date().toISOString().split('T')[0];
        }

        function sanitizeDateInput(dateVal) {
            const todayStr = new Date().toISOString().split('T')[0];
            if (!dateVal) return todayStr;
            let str = String(dateVal).trim();

            const isoMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
            if (isoMatch) {
                let y = parseInt(isoMatch[1], 10);
                let m = parseInt(isoMatch[2], 10);
                let d = parseInt(isoMatch[3], 10);
                if (y >= 1990 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            const malformed3DigitYear = str.match(/^(\d{3})[-/.](\d{1,2})[-/.](\d{1,2})$/);
            if (malformed3DigitYear) {
                let y3 = malformed3DigitYear[1];
                let m = parseInt(malformed3DigitYear[2], 10);
                let d = parseInt(malformed3DigitYear[3], 10);
                let y = (y3.startsWith('2') && y3[1] >= '0' && y3[1] <= '9') ? '20' + y3.substring(0, 2) : '2026';
                if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            const dmyMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2}|\d{2})$/);
            if (dmyMatch) {
                let d = parseInt(dmyMatch[1], 10);
                let m = parseInt(dmyMatch[2], 10);
                let y = dmyMatch[3].length === 2 ? '20' + dmyMatch[3] : dmyMatch[3];
                if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                }
            }

            const parsed = new Date(str);
            if (!isNaN(parsed.getTime())) {
                const y = parsed.getFullYear();
                if (y >= 1990 && y <= 2099) {
                    const m = String(parsed.getMonth() + 1).padStart(2, '0');
                    const d = String(parsed.getDate()).padStart(2, '0');
                    return `${y}-${m}-${d}`;
                }
            }

            return todayStr;
        }

        function cleanItemName(name) {
            if (!name) return "";
            return name.replace(/\bMYPK\b/gi, 'MamyPoko')
                       .replace(/\bMAMY POKO\b/gi, 'MamyPoko')
                       .replace(/\bSWTY\b/gi, 'Sweety')
                       .replace(/\bZWTSL\b/gi, 'Zwitsal')
                       .replace(/\bMYK TELON\b/gi, 'Minyak Telon')
                       .replace(/\bSGM EKSPLOR\b/gi, 'SGM Eksplor')
                       .trim();
        }

        function capitalizeWords(str) {
            if (!str) return "";
            return str.replace(/\b\w/g, l => l.toUpperCase());
        }

        /* REKOMENDASI MODUL DAN SUBKATEGORI (CATEGORY & SUBCATEGORY RECOMMENDATION ENGINE) */
        const CATEGORY_RULES = [
            // 1. KEBUTUHAN BAYI (id: "bayi")
            {
                catId: "bayi",
                subCat: "Popok",
                keywords: [
                    "mamypoko", "mamy poko", "mypk", "sweety", "swty", "pampers", "merries", "popok",
                    "diaper", "pants m", "pants l", "pants xl", "pants s", "pants nb", "baby happy",
                    "goon", "goo.n", "nepia", "genki", "drypers", "huggies", "clodi"
                ]
            },
            {
                catId: "bayi",
                subCat: "Susu & Makanan",
                keywords: [
                    "sgm", "bebelac", "morinaga", "dancow baby", "chil kid", "chil mil", "chil school",
                    "nutrilon", "pediasure", "s-26", "s26", "promina", "cerelac", "milna", "sun bubur",
                    "bubur bayi", "biskuit bayi", "pureeland", "sufor", "susu formula", "mpasi", "pudding bayi"
                ]
            },
            {
                catId: "bayi",
                subCat: "Kesehatan & Mandi",
                keywords: [
                    "zwitsal", "zwtsl", "cussons baby", "cussons", "my baby", "minyak telon", "myk telon",
                    "telon", "baby bath", "baby shampoo", "baby soap", "baby lotion", "baby oil",
                    "baby cream", "bedak bayi", "caladine baby", "sudocrem", "sebamed baby", "pure baby",
                    "cotton buds baby", "kapas bulat", "tissue basah baby", "baby wipes", "konicare"
                ]
            },
            {
                catId: "bayi",
                subCat: "Gear & Perlengkapan",
                keywords: [
                    "stroller", "kereta dorong", "botol susu", "philips avent", "pigeon", "hakaa", "dot bayi",
                    "pacifier", "empeng", "sterilizer", "breast pump", "pompa asi", "kantong asi",
                    "cooler bag asi", "gendongan", "hipseat", "baby carrier", "teether", "car seat",
                    "baby walker", "bouncer", "high chair", "baby bather", "bak mandi bayi"
                ]
            },
            {
                catId: "bayi",
                subCat: "Pakaian",
                keywords: [
                    "jumper bayi", "romper bayi", "jumper", "romper", "baju kodok", "sleepsuit",
                    "gurita bayi", "sarung tangan bayi", "kaos kaki bayi", "bib bayi", "celemek bayi",
                    "slaber", "baju bayi", "celana bayi", "singlet bayi", "topi bayi", "bedong"
                ]
            },
            {
                catId: "bayi",
                subCat: "Mainan & Buku",
                keywords: [
                    "mainan bayi", "rattle", "teether rattle", "playmat", "soft book", "buku bantal",
                    "busy book", "musical mobile"
                ]
            },

            // 2. BELANJA DAPUR & GROCERIES (id: "dapur")
            {
                catId: "dapur",
                subCat: "Perlengkapan Cuci",
                keywords: [
                    "sunlight", "mama lemon", "mama lime", "rinso", "soklin", "so klin", "daia", "attack",
                    "molto", "downy", "vanish", "harpic", "wipol", "super pel", "sabun cuci piring",
                    "deterjen", "detergent", "pewangi pakaian", "pembersih lantai", "kamper", "bayfresh", "glade", "stella"
                ]
            },
            {
                catId: "dapur",
                subCat: "Sembako & Bumbu",
                keywords: [
                    "beras", "pandan wangi", "ramos", "sania", "bimoli", "filma", "tropical", "fortune",
                    "minyak goreng", "minyak", "gula pasir", "gulaku", "garam", "terigu", "segitiga biru",
                    "bumbu", "royco", "masako", "sasa", "ajinomoto", "ladaku", "ketumbar", "merica",
                    "kecap", "bango", "abc", "saus sambal", "saos", "santan", "kara", "bawang merah",
                    "bawang putih", "bawang bombay", "cabai", "cabe", "telur ayam", "telur", "margarin", "blue band"
                ]
            },
            {
                catId: "dapur",
                subCat: "Sayur & Buah",
                keywords: [
                    "sayur", "bayam", "kangkung", "wortel", "brokoli", "tomat", "kentang", "jagung",
                    "buncis", "labu", "kubis", "kol", "apel", "jeruk", "pisang", "semangka", "melon",
                    "mangga", "alpukat", "anggur", "pepaya", "buah"
                ]
            },
            {
                catId: "dapur",
                subCat: "Daging & Ikan",
                keywords: [
                    "daging sapi", "daging", "ayam fillet", "ayam broiler", "dada ayam", "paha ayam", "ayam",
                    "ikan kembung", "ikan gurame", "ikan salmon", "ikan tuna", "ikan", "udang", "cumi",
                    "bakso", "sosis", "kanzler", "nugget", "fiesta", "champ"
                ]
            },
            {
                catId: "dapur",
                subCat: "Makanan Instan & Camilan",
                keywords: [
                    "indomie", "mie sedap", "mie sedaap", "sarimi", "pop mie", "mie instan", "spaghetti",
                    "makaroni", "pasta", "wafer", "tango", "oreo", "chiki", "chitato", "lays", "qtela",
                    "biskuit", "roma", "khong guan", "snack", "camilan", "roti tawar", "sari roti"
                ]
            },
            {
                catId: "dapur",
                subCat: "Minuman",
                keywords: [
                    "aqua", "le minerale", "cleo", "air mineral", "kopi kapal api", "nescafe", "kopi",
                    "teh sariwangi", "teh botol", "teh pucuk", "teh", "susu ultra", "ultra milk",
                    "cimory", "bear brand", "pocari sweat", "isoplus", "jus buavita", "sirup marjan"
                ]
            },
            {
                catId: "dapur",
                subCat: "Alat Dapur",
                keywords: [
                    "wajan", "teflon", "panci", "spatula", "sutil", "pisau dapur", "talenan",
                    "spons cuci", "sponge", "rak piring", "serbet", "lap dapur", "alumunium foil", "cling wrap"
                ]
            },

            // 3. TAGIHAN & RUTINITAS RUMAH (id: "tagihan")
            {
                catId: "tagihan",
                subCat: "Listrik PLN",
                keywords: [
                    "token pln", "stroom", "listrik pln", "pln prabayar", "pln pascabayar", "idpel pln", "pln", "listrik", "meteran listrik"
                ]
            },
            {
                catId: "tagihan",
                subCat: "Air PDAM",
                keywords: [
                    "pdam", "aetra", "palyja", "air pdam", "tagihan air", "pam jaya"
                ]
            },
            {
                catId: "tagihan",
                subCat: "Internet & WiFi",
                keywords: [
                    "indihome", "first media", "biznet", "myrepublic", "cbn", "iconnet", "wifi rumah",
                    "internet rumah", "oxygen", "telkom"
                ]
            },
            {
                catId: "tagihan",
                subCat: "Gas Elpiji",
                keywords: [
                    "gas elpiji", "gas lpg", "bright gas", "gas 3kg", "gas 12kg", "tabung gas"
                ]
            },
            {
                catId: "tagihan",
                subCat: "Iuran RT/RW & Keamanan",
                keywords: [
                    "iuran rt", "iuran rw", "iuran keamanan", "satpam", "keamanan lingkungan", "ipl apartemen"
                ]
            },
            {
                catId: "tagihan",
                subCat: "Sampah & Kebersihan",
                keywords: [
                    "retribusi sampah", "uang sampah", "kebersihan lingkungan"
                ]
            },
            {
                catId: "tagihan",
                subCat: "Cicilan & Sewa",
                keywords: [
                    "kpr", "cicilan rumah", "sewa rumah", "sewa kontrakan"
                ]
            },

            // 4. TRANSPORTASI & KENDARAAN (id: "transport")
            {
                catId: "transport",
                subCat: "Bensin & BBM",
                keywords: [
                    "pertamax", "pertalite", "solar", "dexlite", "pertamina dex", "shell super", "shell v-power",
                    "bp 92", "bbm", "bensin", "spbu"
                ]
            },
            {
                catId: "transport",
                subCat: "Tol & Parkir",
                keywords: [
                    "etoll", "e-toll", "tarif tol", "gerbang tol", "parkir", "karcis parkir", "parking"
                ]
            },
            {
                catId: "transport",
                subCat: "Servis & Oli",
                keywords: [
                    "ganti oli", "oli mesin", "oli motul", "oli shell", "oli castrol", "tune up",
                    "servis berkala", "servis mobil", "servis motor", "spooring", "balancing"
                ]
            },
            {
                catId: "transport",
                subCat: "Cuci Kendaraan",
                keywords: [
                    "cuci mobil", "cuci motor", "car wash", "salon mobil", "poles mobil"
                ]
            },
            {
                catId: "transport",
                subCat: "Angkutan Umum / Ojol",
                keywords: [
                    "gojek", "goride", "gocar", "grab", "grabcar", "grabbike", "krl", "commuter line",
                    "mrt", "lrt", "transjakarta", "busway", "tiket kereta", "kai", "damri", "taksi", "bluebird"
                ]
            },
            {
                catId: "transport",
                subCat: "Sparepart",
                keywords: [
                    "ban mobil", "ban motor", "aki", "accu", "busi", "kampas rem", "wiper", "lampu mobil", "helm"
                ]
            },

            // 5. TABUNGAN & INVESTASI (id: "tabungan")
            {
                catId: "tabungan",
                subCat: "Emas & Logam Mulia",
                keywords: [
                    "antam", "logam mulia", "emas batangan", "ubs gold", "tabungan emas"
                ]
            },
            {
                catId: "tabungan",
                subCat: "Reksadana & Saham",
                keywords: [
                    "bibit", "bareksa", "ajaib", "reksadana", "beli saham", "sukuk", "sbn", "ori"
                ]
            }
        ];

        function inferCategoryAndSubCategory(itemName, merchant, hintCatId, hintSubCat) {
            const rawItem = (itemName || "").toLowerCase();
            const rawMerc = (merchant || "").toLowerCase();

            // 1. Cek kecocokan keyword langsung pada nama barang
            for (const rule of CATEGORY_RULES) {
                for (const kw of rule.keywords) {
                    if (rawItem.includes(kw)) {
                        return { masterCategoryId: rule.catId, subCategory: rule.subCat };
                    }
                }
            }

            // 2. Evaluasi hint AI jika diberikan & valid
            const validCatIds = ["bayi", "dapur", "tagihan", "transport", "tabungan"];
            let normalizedHintCat = (hintCatId || "").toLowerCase();
            if (!validCatIds.includes(normalizedHintCat)) {
                if (normalizedHintCat.includes('bayi') || normalizedHintCat.includes('baby')) normalizedHintCat = 'bayi';
                else if (normalizedHintCat.includes('dapur') || normalizedHintCat.includes('grocer') || normalizedHintCat.includes('makan')) normalizedHintCat = 'dapur';
                else if (normalizedHintCat.includes('tagih') || normalizedHintCat.includes('listrik') || normalizedHintCat.includes('bill')) normalizedHintCat = 'tagihan';
                else if (normalizedHintCat.includes('trans') || normalizedHintCat.includes('kendaraan') || normalizedHintCat.includes('bbm')) normalizedHintCat = 'transport';
                else if (normalizedHintCat.includes('tabung') || normalizedHintCat.includes('invest')) normalizedHintCat = 'tabungan';
                else normalizedHintCat = '';
            }

            if (normalizedHintCat) {
                const targetCat = state.masterCategories.find(c => c.id === normalizedHintCat);
                if (targetCat) {
                    if (hintSubCat) {
                        const directMatch = targetCat.subCategories.find(s => s.toLowerCase() === hintSubCat.toLowerCase());
                        if (directMatch) return { masterCategoryId: normalizedHintCat, subCategory: directMatch };
                        const fuzzyMatch = targetCat.subCategories.find(s => s.toLowerCase().includes(hintSubCat.toLowerCase()) || hintSubCat.toLowerCase().includes(s.toLowerCase()));
                        if (fuzzyMatch) return { masterCategoryId: normalizedHintCat, subCategory: fuzzyMatch };
                    }
                    return { masterCategoryId: normalizedHintCat, subCategory: targetCat.subCategories[0] || "Lainnya" };
                }
            }

            // 3. Cek kecocokan keyword pada nama merchant/toko
            for (const rule of CATEGORY_RULES) {
                for (const kw of rule.keywords) {
                    if (rawMerc.includes(kw)) {
                        return { masterCategoryId: rule.catId, subCategory: rule.subCat };
                    }
                }
            }

            // 4. Heuristik nama merchant umum
            if (rawMerc.includes('pln') || rawMerc.includes('listrik') || rawMerc.includes('pdam') || rawMerc.includes('indihome')) {
                return { masterCategoryId: "tagihan", subCategory: "Listrik PLN" };
            }
            if (rawMerc.includes('pertamina') || rawMerc.includes('spbu') || rawMerc.includes('shell') || rawMerc.includes('bp')) {
                return { masterCategoryId: "transport", subCategory: "Bensin & BBM" };
            }
            if (rawMerc.includes('mothercare') || rawMerc.includes('baby')) {
                return { masterCategoryId: "bayi", subCategory: "Popok" };
            }

            // 5. Default fallback yang aman: Belanja Dapur -> Sembako & Bumbu
            return { masterCategoryId: "dapur", subCategory: "Sembako & Bumbu" };
        }

        /* HEURISTIK REGEX LOKAL (UNTUK OCR OFFLINE & FALLBACK - DARI TEST_OCR.HTML) */
        function runAdvancedSmartEngine(rawText) {
            const text = rawText || "";
            const lower = text.toLowerCase();

            let merchant = "Belanja Rumah Tangga";
            let suggestedCategory = "dapur";

            if (lower.includes('super indo')) { merchant = "Super Indo Supermarket"; suggestedCategory = "dapur"; }
            else if (lower.includes('indomaret')) { merchant = "Indomaret"; suggestedCategory = "dapur"; }
            else if (lower.includes('alfamart')) { merchant = "Alfamart"; suggestedCategory = "dapur"; }
            else if (lower.includes('tokopedia')) { merchant = "Tokopedia (Official Store)"; suggestedCategory = "dapur"; }
            else if (lower.includes('mothercare') || lower.includes('mamy poko') || lower.includes('zwitsal') || lower.includes('pampers') || lower.includes('sweety')) {
                merchant = "Toko Perlengkapan Bayi"; suggestedCategory = "bayi";
            }
            else if (lower.includes('pln') || lower.includes('token') || lower.includes('listrik') || lower.includes('pdam') || lower.includes('indihome')) {
                merchant = "PLN / Tagihan Rutin"; suggestedCategory = "tagihan";
            }
            else if (lower.includes('pertamina') || lower.includes('spbu') || lower.includes('shell') || lower.includes('pertamax') || lower.includes('pertalite')) {
                merchant = "SPBU Pertamina"; suggestedCategory = "transport";
            }

            let date = extractSmartDate(text);

            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            let discount = 0;
            let tax = 0;

            for (let line of lines) {
                const lLower = line.toLowerCase();
                if (lLower.includes('diskon') || lLower.includes('hemat') || lLower.includes('potongan') || lLower.includes('voucher') || lLower.includes('promo') || lLower.includes('kupon')) {
                    const dMatch = line.match(/(?:rp\.?\s*)?[-–—]?\s*(\d{1,3}(?:[.,]\d{3})*(?:,\d{2})?|\d{4,7})/i);
                    if (dMatch) {
                        const val = parseInt(dMatch[1].replace(/[.,]/g, ''), 10);
                        if (val > 0 && val < 50000000) discount += val;
                    }
                }
                if (lLower.includes('ppn') || lLower.includes('pajak') || lLower.includes('pb1') || lLower.includes('tax')) {
                    const tMatch = line.match(/(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})*(?:,\d{2})?|\d{4,7})/i);
                    if (tMatch) {
                        const val = parseInt(tMatch[1].replace(/[.,]/g, ''), 10);
                        if (val > 0 && val < 50000000) tax += val;
                    }
                }
            }

            const items = [];
            for (let line of lines) {
                const lLower = line.toLowerCase();
                if (lLower.startsWith('total') || lLower.startsWith('subtotal') || lLower.startsWith('tunai') ||
                    lLower.startsWith('kembali') || lLower.startsWith('bayar') || lLower.includes('diskon') ||
                    lLower.includes('hemat') || lLower.includes('ppn') || lLower.includes('pajak') ||
                    lLower.includes('terima kasih') || lLower.includes('pt ') || lLower.includes('npwp') || lLower.includes('shopeepay')) {
                    continue;
                }

                const priceMatch = line.match(/(?:rp\.?\s*)?(\d{1,3}(?:[.,]\d{3})*(?:,\d{2})?|\d{4,7})/i);
                if (priceMatch) {
                    let cost = parseInt(priceMatch[1].replace(/[.,]/g, ''), 10);
                    let name = line.substring(0, priceMatch.index).trim();
                    let qty = 1;
                    const qtyMatch = line.match(/(\d+)\s*(?:x|pcs|buah|kg|liter)/i) || name.match(/(\d+)\s*x/i);
                    if (qtyMatch) {
                        qty = parseInt(qtyMatch[1], 10) || 1;
                        name = name.replace(qtyMatch[0], '').trim();
                    }
                    name = name.replace(/^[0-9\-\*\#\.\s]+/, '').replace(/(\d+)\s*x\s*[\d\.\,]+/gi, '').trim();

                    if (name.length >= 3 && cost >= 1000 && cost < 50000000) {
                        const cName = cleanItemName(name);
                        const inf = inferCategoryAndSubCategory(cName, merchant);
                        items.push({
                            itemName: cName,
                            masterCategoryId: inf.masterCategoryId,
                            subCategory: inf.subCategory,
                            qty: qty,
                            cost: cost
                        });
                    }
                }
            }

            if (items.length === 0) {
                const inf = inferCategoryAndSubCategory(merchant, merchant);
                items.push({
                    itemName: merchant,
                    masterCategoryId: inf.masterCategoryId,
                    subCategory: inf.subCategory,
                    qty: 1,
                    cost: 50000
                });
            }

            const subtotal = items.reduce((sum, it) => sum + (it.cost * (it.qty || 1)), 0);
            const grandTotal = Math.max(subtotal - discount + tax, 0);

            return {
                merchant: merchant,
                date: date,
                suggestedMasterCategoryId: suggestedCategory,
                items: items,
                subtotal: subtotal,
                discount: discount,
                tax: tax,
                grandTotal: grandTotal
            };
        }

        /* PRESET UJI COBA CEPAT REALISTIS (DARI TEST_OCR.HTML & DEFAULT) */
        function loadRealisticPreset(type) {
            let sampleText = '';
            if (type === 'superindo') {
                sampleText = `SUPER INDO CEMPAKA PUTIH
PT LION SUPER INDO
TGL: 05/11/2026 14:15:20

MINYAK GORENG SANIA 2L        1   35.900
BERAS PANDAN WANGI 5KG        1   78.500
TELUR AYAM NEGERI 1KG         1   31.200
SUNLIGHT JERUK NIPIS 700ML    1   14.800

SUBTOTAL                         160.400
HEMAT PROMO MEMBER               -10.000
PPN 11%                            2.500
TOTAL BELANJA                    152.900`;
            } else if (type === 'indomaret') {
                sampleText = `INDOMARET RAWAMANGUN
PT INDOMARCO PRISMATAMA
TGL: 05/11/2026 10:22:10

MAMY POKO PANTS M34          1   85.000
SGM EKSPLOR 1+ MADU 900G     1   92.500
ZWITSAL BABY BATH 2IN1 450ML 1   38.000
MYK TELON MY BABY 90ML       1   24.500

SUBTOTAL                         240.000
DISKON PROMO JSM                  -8.000
PPN 11%                            2.000
TOTAL AKHIR                      234.000`;
            } else if (type === 'alfamart') {
                sampleText = `ALFAMART TEBET TIMUR
PT SUMBER ALFARIA TRIJAYA TBK
04/11/2026 09:15:44

MYK TELON PLUS MY BABY 90ML   1   24.500
SWEETY BRONZE PANTS L30       1   62.000
PROMINA BUBUR BAYI AYAM KG    2   18.000
CUSSONS BABY CREAM SOFT 50G   1   19.500

SUBTOTAL                         124.000
HEMAT PROMO JSM                   -5.000
PPN 11%                            1.500
TOTAL BELANJA                    120.500`;
            } else if (type === 'tokopedia') {
                sampleText = `INVOICE TOKOPEDIA
Nomor: INV/20261105/MPL/98421049
Tanggal: 05/11/2026
Penjual: Baby Official Store

1. Baby Stroller Lipat Cabin Size   1 x Rp 850.000
2. Philips Avent Botol Susu 260ml   2 x Rp 145.000
3. Jumper Bayi Katun Organik 3in1   1 x Rp 95.000

Subtotal Tagihan               Rp 1.235.000
Diskon Kupon Promo Belanja    -Rp 50.000
Pajak & Biaya Jasa Aplikasi    Rp 4.000
Total Pembayaran               Rp 1.189.000`;
            } else if (type === 'pln') {
                sampleText = `STRUK PEMBELIAN LISTRIK PRABAYAR
PLN DISTRIBUSI JAKARTA RAYA
TANGGAL: 05/11/2026 08:45:10
NO METER: 14285910294
IDPEL: 538102948192
NAMA: KELUARGA SATURUMA
TARIF/DAYA: R1M / 2200 VA

STROOM / TOKEN PLN            1  500.000
ADMIN BANK / PPJ              1    2.500
TOTAL BAYAR                      502.500`;
            } else if (type === 'pertamina') {
                sampleText = `SPBU PERTAMINA 31.134.02
JL. PRAMUKA RAYA NO. 45
TGL: 05/11/2026 16:30:15

PERTAMAX 92 (18.52 LITER)     1  250.000
TOTAL TRANSAKSI                  250.000
TUNAI                            250.000
KEMBALIAN                              0`;
            }

            const rawLog = document.getElementById('rawDebugLog');
            if (rawLog) rawLog.value = sampleText;
            currentFile = null;
            currentBase64 = null;

            showToast("Preset dimuat. Memulai pemindaian...");
            executeScan();
        }

        function generateRealisticHouseholdExtraction() {
            return {
                merchant: "Super Indo Supermarket",
                date: formatToStrictDateString(new Date()),
                suggestedMasterCategoryId: "dapur",
                items: [
                    { itemName: "Minyak Goreng Sania 2L", subCategory: "Sembako & Bumbu", qty: 1, cost: 35900 },
                    { itemName: "Beras Pandan Wangi 5kg", subCategory: "Sembako & Bumbu", qty: 1, cost: 78500 },
                    { itemName: "Sunlight Jeruk Nipis 700ml", subCategory: "Perlengkapan Cuci", qty: 1, cost: 14800 }
                ],
                discount: 10000,
                tax: 2500,
                grandTotal: 119200
            };
        }

        /* ALIKAN HASIL KE FORMULIR BELANJA TERPADU */
        function applyExtractedDataToForm(d, sourceBadge) {
            if (!d) return;

            document.getElementById('formMerchant').value = d.merchant || 'Belanja Rumah Tangga';
            const safeDate = sanitizeDateInput(d.date);
            const formDateEl = document.getElementById('formDate');
            if (formDateEl) {
                formDateEl.value = safeDate;
            }

            const discountVal = Number(d.discount) || 0;
            const taxVal = Number(d.tax) || 0;
            document.getElementById('formDiscount').value = formatThousand(discountVal);
            document.getElementById('formTax').value = formatThousand(taxVal);

            if (currentBase64) {
                updateFormReceiptPhotoDisplay(currentBase64);
            }

            // Normalisasi & inferensi modul + subkategori untuk tiap barang hasil scan (jika ada)
            let rawItems = (d.items && Array.isArray(d.items) && d.items.length > 0) ? d.items : [];

            const resolvedItems = rawItems.map(it => {
                const inf = inferCategoryAndSubCategory(
                    it.itemName,
                    d.merchant,
                    it.masterCategoryId || d.suggestedMasterCategoryId,
                    it.subCategory
                );
                return {
                    ...it,
                    masterCategoryId: inf.masterCategoryId,
                    subCategory: inf.subCategory
                };
            });

            // Hitung subtotal rincian barang jika ada
            let itemsSum = 0;
            if (resolvedItems.length > 0) {
                resolvedItems.forEach(it => {
                    const c = Number(it.cost) || 0;
                    const q = Number(it.qty) || 1;
                    itemsSum += (c * q);
                });
            }

            const subtotalVal = (itemsSum > 0) ? itemsSum : (Number(d.subtotal) || Number(d.grandTotal) || 0);
            const subtotalInp = document.getElementById('formSubtotalDisplay');
            if (subtotalInp) {
                subtotalInp.value = formatThousand(subtotalVal);
            }

            // Fallback baris barang: jika struk tunggal tanpa rincian barang (misal: token PLN, bensin, parkir)
            if (resolvedItems.length === 0 && subtotalVal > 0) {
                const defCat = d.suggestedMasterCategoryId || 'dapur';
                const inf = inferCategoryAndSubCategory(d.merchant, d.merchant, defCat);
                resolvedItems.push({
                    itemName: d.itemName || d.merchant || 'Belanja Rumah Tangga',
                    masterCategoryId: inf.masterCategoryId,
                    subCategory: inf.subCategory,
                    qty: 1,
                    cost: subtotalVal
                });
            }

            // Alokasi Selisih Scan:
            // Apabila terdapat ketidaksesuaian perhitungan pada total aktual dengan rumus dasar (Subtotal - Diskon + Pajak),
            // maka selisih angka tersebut akan otomatis dimasukkan ke kolom "Lainnya/Other".
            const actualTotal = Number(d.grandTotal !== undefined ? d.grandTotal : (d.total !== undefined ? d.total : (d.totalAmount !== undefined ? d.totalAmount : 0)));
            const baseExpectedTotal = subtotalVal - discountVal + taxVal;
            let diff = 0;
            if (actualTotal > 0 && actualTotal !== baseExpectedTotal) {
                diff = actualTotal - baseExpectedTotal;
            } else if (d.other !== undefined && d.other !== null) {
                diff = Number(d.other) || 0;
            }

            const otherInp = document.getElementById('formOther');
            if (otherInp) {
                otherInp.value = formatSignedThousand(diff);
            }

            // Analisis distribusi modul kategori pada seluruh item belanja
            const catFrequency = {};
            resolvedItems.forEach(it => {
                catFrequency[it.masterCategoryId] = (catFrequency[it.masterCategoryId] || 0) + 1;
            });
            const uniqueCats = Object.keys(catFrequency);

            const formMasterCatSel = document.getElementById('formMasterCategorySelect');
            if (uniqueCats.length > 1) {
                // Item berasal dari beberapa modul berbeda -> aktifkan Multi-Modul secara otomatis
                if (formMasterCatSel) {
                    formMasterCatSel.value = 'all';
                    handleFormCategoryChange('all');
                }
            } else if (uniqueCats.length === 1) {
                // Semua item berasal dari 1 modul yang sama -> pilih modul tersebut
                const singleCat = uniqueCats[0];
                if (formMasterCatSel) {
                    formMasterCatSel.value = singleCat;
                    handleFormCategoryChange(singleCat);
                }
            } else {
                const defCat = d.suggestedMasterCategoryId || 'dapur';
                if (formMasterCatSel) {
                    formMasterCatSel.value = defCat;
                    handleFormCategoryChange(defCat);
                }
            }

            // Isi Repeater Items (hanya jika ada rincian barang dari hasil scan)
            const container = document.getElementById('formItemsContainer');
            if (container) container.innerHTML = '';
            state.formItemIndexCounter = 0;

            if (resolvedItems.length > 0) {
                resolvedItems.forEach(it => addNewItemRow(it));
            }

            updateItemCountBadge();
            calculateFormGrandTotal(false);
            switchInputSubMode('manual');

            const formSec = document.getElementById('transactionForm');
            if (formSec) formSec.scrollIntoView({ behavior: 'smooth' });

            const diffNotice = diff !== 0 ? ` (Selisih ${diff > 0 ? '+' : ''}${formatSignedThousand(diff)} dialokasikan ke Lainnya)` : '';
            showToast(`Berhasil dipindai via [${sourceBadge}] (${resolvedItems.length} barang)!${diffNotice}`);
        }

        /* ========================================================
           6. RIWAYAT STRUK & TRANSAKSI (FILTER, SORT, EDIT, CSV)
           ======================================================== */
        function handleHistoryPeriodChange(val) {
            const customRow = document.getElementById('historyCustomDateRow');
            if (customRow) {
                if (val === 'custom') {
                    customRow.classList.remove('hidden');
                    const sInp = document.getElementById('historyStartDate');
                    const eInp = document.getElementById('historyEndDate');
                    if (sInp && !sInp.value && eInp && !eInp.value) {
                        const now = new Date();
                        eInp.value = formatToStrictDateString(now);
                        const sDate = new Date(now);
                        sDate.setDate(sDate.getDate() - 7);
                        sInp.value = formatToStrictDateString(sDate);
                    }
                } else {
                    customRow.classList.add('hidden');
                }
            }
            syncHistoryPeriodPills(val);
            filterHistoryList();
        }

        function setHistoryPeriodQuick(periodVal) {
            const periodSelect = document.getElementById('historyPeriodFilter');
            if (periodSelect) {
                periodSelect.value = periodVal;
            }
            handleHistoryPeriodChange(periodVal);
        }

        function clearHistoryCustomDate() {
            const sInp = document.getElementById('historyStartDate');
            const eInp = document.getElementById('historyEndDate');
            if (sInp) sInp.value = '';
            if (eInp) eInp.value = '';
            filterHistoryList();
        }

        function syncHistoryPeriodPills(currentVal) {
            const pills = document.querySelectorAll('.history-period-pill');
            pills.forEach(pill => {
                const p = pill.getAttribute('data-period');
                if (p === currentVal) {
                    pill.className = "history-period-pill text-[11px] px-2.5 py-1 rounded-lg border border-[var(--primary)] bg-[var(--primary)] text-white font-bold transition-all whitespace-nowrap shadow-2xs";
                } else {
                    pill.className = "history-period-pill text-[11px] px-2.5 py-1 rounded-lg border border-[var(--border-color)] text-[var(--text-muted)] font-semibold transition-all whitespace-nowrap hover:border-[var(--primary)] hover:text-[var(--text-main)]";
                }
            });
        }

        function resetHistoryFilters() {
            const searchInp = document.getElementById('historySearchInput');
            if (searchInp) searchInp.value = '';
            const catSelect = document.getElementById('historyCategoryFilter');
            if (catSelect) catSelect.value = 'all';
            const periodSelect = document.getElementById('historyPeriodFilter');
            if (periodSelect) periodSelect.value = 'thisMonth';
            const dateSortSelect = document.getElementById('historyDateSort');
            if (dateSortSelect) dateSortSelect.value = 'newest';
            const amountSortSelect = document.getElementById('historyAmountSort');
            if (amountSortSelect) amountSortSelect.value = 'none';
            const sortSelect = document.getElementById('historySortOrder');
            if (sortSelect) sortSelect.value = 'newest';

            const customRow = document.getElementById('historyCustomDateRow');
            if (customRow) customRow.classList.add('hidden');
            const startInp = document.getElementById('historyStartDate');
            if (startInp) startInp.value = '';
            const endInp = document.getElementById('historyEndDate');
            if (endInp) endInp.value = '';

            syncHistoryPeriodPills('thisMonth');
            filterHistoryList();
            showToast("Filter riwayat transaksi berhasil direset ke default.", "info", 1500);
        }

        function filterHistoryList() {
            const container = document.getElementById('historyReceiptsContainer');
            if (!container) return;

            const searchQuery = (document.getElementById('historySearchInput')?.value || '').toLowerCase();
            const catFilter = document.getElementById('historyCategoryFilter')?.value || 'all';
            const periodFilter = document.getElementById('historyPeriodFilter')?.value || 'thisMonth';
            const sortVal = document.getElementById('historySortOrder')?.value || document.getElementById('historyDateSort')?.value || 'newest';

            // Sinkronkan baris kustom dan tombol cepat periode
            const customRow = document.getElementById('historyCustomDateRow');
            if (customRow) {
                if (periodFilter === 'custom') {
                    customRow.classList.remove('hidden');
                } else {
                    customRow.classList.add('hidden');
                }
            }
            syncHistoryPeriodPills(periodFilter);

            // Sinkronkan aksen warna tampilan riwayat mengikuti kategori yang dipilih (termasuk Multi-Modul)
            if (catFilter === 'all') {
                const multiConf = getMultiModuleConfig();
                applyDynamicAccentColor(multiConf.color || '#10B981');
            } else {
                const cat = state.masterCategories.find(c => c.id === catFilter || c.sheetName === catFilter);
                if (cat && cat.color) {
                    applyDynamicAccentColor(cat.color);
                }
            }

            let list = [...state.receipts];

            // 1. Filter Kategori
            if (catFilter !== 'all') {
                list = list.filter(r => r.masterCategoryId === catFilter || r.masterSheetName === catFilter || (r.items && r.items.some(i => i.masterCategoryId === catFilter || i.sheetName === catFilter)));
            }

            // 2. Filter Periode Waktu
            const now = new Date();
            const todayStr = formatToStrictDateString(now);

            if (periodFilter === 'today') {
                list = list.filter(r => (r.date || '') === todayStr);
            } else if (periodFilter === 'yesterday') {
                const yest = new Date(now);
                yest.setDate(now.getDate() - 1);
                const yestStr = formatToStrictDateString(yest);
                list = list.filter(r => (r.date || '') === yestStr);
            } else if (periodFilter === 'thisWeek') {
                const day = now.getDay(); // 0: Minggu, 1: Senin, dst.
                const diffToMon = (day === 0 ? -6 : 1) - day;
                const mon = new Date(now);
                mon.setDate(now.getDate() + diffToMon);
                const sun = new Date(mon);
                sun.setDate(mon.getDate() + 6);
                const monStr = formatToStrictDateString(mon);
                const sunStr = formatToStrictDateString(sun);
                list = list.filter(r => {
                    const d = r.date || '';
                    return d >= monStr && d <= sunStr;
                });
            } else if (periodFilter === 'lastWeek') {
                const day = now.getDay();
                const diffToMon = (day === 0 ? -6 : 1) - day;
                const prevMon = new Date(now);
                prevMon.setDate(now.getDate() + diffToMon - 7);
                const prevSun = new Date(prevMon);
                prevSun.setDate(prevMon.getDate() + 6);
                const prevMonStr = formatToStrictDateString(prevMon);
                const prevSunStr = formatToStrictDateString(prevSun);
                list = list.filter(r => {
                    const d = r.date || '';
                    return d >= prevMonStr && d <= prevSunStr;
                });
            } else if (periodFilter === 'last7Days') {
                const d7 = new Date(now);
                d7.setDate(now.getDate() - 6);
                const d7Str = formatToStrictDateString(d7);
                list = list.filter(r => {
                    const d = r.date || '';
                    return d >= d7Str && d <= todayStr;
                });
            } else if (periodFilter === 'thisMonth') {
                const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                list = list.filter(r => (r.date || '').substring(0, 7) === curYM);
            } else if (periodFilter === 'lastMonth') {
                const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                const lmYM = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}`;
                list = list.filter(r => (r.date || '').substring(0, 7) === lmYM);
            } else if (periodFilter === 'last30Days') {
                const d30 = new Date(now);
                d30.setDate(now.getDate() - 29);
                const d30Str = formatToStrictDateString(d30);
                list = list.filter(r => {
                    const d = r.date || '';
                    return d >= d30Str && d <= todayStr;
                });
            } else if (periodFilter === 'thisYear') {
                list = list.filter(r => (r.date || '').substring(0, 4) === String(now.getFullYear()));
            } else if (periodFilter === 'lastYear') {
                list = list.filter(r => (r.date || '').substring(0, 4) === String(now.getFullYear() - 1));
            } else if (periodFilter === 'custom') {
                let startVal = (document.getElementById('historyStartDate')?.value || '').trim();
                let endVal = (document.getElementById('historyEndDate')?.value || '').trim();
                if (startVal && endVal && startVal > endVal) {
                    [startVal, endVal] = [endVal, startVal];
                }
                if (startVal) {
                    list = list.filter(r => (r.date || '') >= startVal);
                }
                if (endVal) {
                    list = list.filter(r => (r.date || '') <= endVal);
                }
            }

            // 3. Search Filter
            if (searchQuery) {
                list = list.filter(r => {
                    const matchMerchant = (r.merchant || '').toLowerCase().includes(searchQuery);
                    const matchId = (r.receiptId || '').toLowerCase().includes(searchQuery);
                    const matchSubCat = (r.subCategory || '').toLowerCase().includes(searchQuery);
                    const matchItem = r.items && r.items.some(i => 
                        (i.itemName || '').toLowerCase().includes(searchQuery) ||
                        (i.subCategory || '').toLowerCase().includes(searchQuery)
                    );
                    return matchMerchant || matchId || matchSubCat || matchItem;
                });
            }

            // 4. Sort (Gabungan Tanggal & Nominal)
            if (sortVal === 'highest') {
                list.sort((a, b) => {
                    const costA = Number(a.totalCost ?? a.totalAmount ?? 0);
                    const costB = Number(b.totalCost ?? b.totalAmount ?? 0);
                    const diff = costB - costA;
                    if (diff !== 0) return diff;
                    return (b.date || '').localeCompare(a.date || '');
                });
            } else if (sortVal === 'lowest') {
                list.sort((a, b) => {
                    const costA = Number(a.totalCost ?? a.totalAmount ?? 0);
                    const costB = Number(b.totalCost ?? b.totalAmount ?? 0);
                    const diff = costA - costB;
                    if (diff !== 0) return diff;
                    return (b.date || '').localeCompare(a.date || '');
                });
            } else if (sortVal === 'oldest') {
                list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
            } else {
                // 'newest' default
                list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            }

            // Update badge info & subtext ringkasan
            const countBadge = document.getElementById('historyReceiptCountBadge');
            const summarySubtext = document.getElementById('historySummarySubtext');
            const totalFilteredCost = list.reduce((acc, r) => acc + (r.totalAmount !== undefined ? r.totalAmount : (r.totalCost || 0)), 0);
            if (countBadge) {
                countBadge.textContent = `${list.length} Struk`;
            }
            if (summarySubtext) {
                summarySubtext.textContent = list.length > 0
                    ? `Total Belanja: ${formatRupiah(totalFilteredCost)} (${list.length} transaksi ditampilkan)`
                    : 'Tidak ada transaksi yang cocok pada filter ini';
            }

            if (list.length === 0) {
                container.innerHTML = `
                    <div class="glass-card p-8 sm:p-10 text-center space-y-3">
                        <div class="w-14 h-14 rounded-2xl bg-[var(--primary-light)] text-[var(--primary)] flex items-center justify-center text-2xl mx-auto shadow-xs">
                            <i class="fa-solid fa-receipt"></i>
                        </div>
                        <div>
                            <h4 class="text-sm font-extrabold text-[var(--text-main)]">Tidak Ada Riwayat Transaksi</h4>
                            <p class="text-xs text-[var(--text-muted)] mt-1 max-w-sm mx-auto">Belum ada struk yang cocok dengan filter. Coba ubah pencarian atau tambahkan transaksi baru sekarang.</p>
                        </div>
                        <div class="pt-2">
                            <button type="button" onclick="setAppMode('input')" class="btn-primary text-xs py-2 px-4 inline-flex items-center gap-2">
                                <i class="fa-solid fa-plus"></i> Tambah / Pindai Struk
                            </button>
                        </div>
                    </div>
                `;
                return;
            }

            let html = '';
            list.forEach(r => {
                let catObj = state.masterCategories.find(c => c.id === r.masterCategoryId || c.sheetName === r.masterSheetName);
                if (r.masterCategoryId === 'all' || r.masterCategoryId === 'multi' || !catObj) {
                    if (r.masterCategoryId === 'all' || r.masterCategoryId === 'multi') {
                        const multiConf = getMultiModuleConfig();
                        catObj = { name: multiConf.name || 'Multi-Modul', color: multiConf.color || '#10B981', icon: multiConf.icon || 'fa-layer-group' };
                    } else {
                        catObj = { name: 'Umum', color: '#10B981', icon: 'fa-receipt' };
                    }
                }
                const itemsCount = r.items ? r.items.length : 1;

                html += `
                    <div class="category-card receipt-card p-4 bg-[var(--bg-card)] space-y-3" style="${getCategoryCardStyle(catObj.color, { borderLeftWidth: '5px' })}">
                        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-[var(--border-color)]">
                            <div class="flex items-center gap-3">
                                <span class="w-10 h-10 rounded-xl flex items-center justify-center text-base font-bold flex-shrink-0" style="background-color: ${hexToRgba(catObj.color, 0.15)}; color: ${catObj.color};">
                                    <i class="fa-solid ${catObj.icon}"></i>
                                </span>
                                <div>
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <h4 class="text-sm font-extrabold text-[var(--text-main)]">${escapeHtml(r.merchant || "Belanja")}</h4>
                                        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full" style="background-color: ${hexToRgba(catObj.color, 0.15)}; color: ${catObj.color};">${escapeHtml(catObj.name)}</span>
                                        ${r.createdByName ? `<span class="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20"><i class="fa-solid fa-user-pen text-[9px]"></i> ${escapeHtml(r.createdByName)}</span>` : ''}
                                    </div>
                                    <span class="text-[11px] text-[var(--text-muted)] mt-0.5 block">
                                        <i class="fa-regular fa-calendar mr-1"></i> ${r.date || "-"} • ID: <span class="font-mono">${r.receiptId}</span>
                                    </span>
                                </div>
                            </div>

                            <div class="flex items-center justify-between sm:justify-end gap-3 pt-2 sm:pt-0 border-t sm:border-t-0 border-[var(--border-color)]">
                                <div class="text-left sm:text-right">
                                    <span class="text-xs text-[var(--text-muted)] block">Total Struk</span>
                                    <span class="text-base font-black text-[var(--text-main)]">${formatRupiah(r.totalAmount || r.totalCost)}</span>
                                </div>

                                <div class="flex items-center gap-1">
                                    ${r.receiptPhotoUrl ? `
                                        <button type="button" 
                                                data-merchant="${escapeHtml(r.merchant)}" 
                                                data-photo="${escapeHtml(r.receiptPhotoUrl)}"
                                                onclick="openPhotoPreviewModal(this.dataset.merchant, this.dataset.photo)" 
                                                class="w-8 h-8 rounded-lg border border-[var(--border-color)] hover:border-[var(--primary)] text-[var(--text-muted)] hover:text-[var(--primary)] flex items-center justify-center text-xs" 
                                                title="Lihat Foto Struk">
                                            <i class="fa-solid fa-file-image"></i>
                                        </button>
                                    ` : ''}
                                    <button type="button" 
                                            data-id="${escapeHtml(r.receiptId)}"
                                            onclick="duplicateReceipt(this.dataset.id)" 
                                            class="h-8 px-2 rounded-lg border border-[var(--border-color)] hover:border-emerald-500 hover:bg-emerald-500/10 text-[var(--text-muted)] hover:text-emerald-600 flex items-center justify-center gap-1 text-xs font-semibold transition-colors" 
                                            title="Catat Pembelian Serupa">
                                        <i class="fa-solid fa-clone text-xs"></i>
                                        <span class="text-[11px] hidden sm:inline whitespace-nowrap">Catat Serupa</span>
                                    </button>
                                    <button type="button" 
                                            data-id="${escapeHtml(r.receiptId)}"
                                            onclick="editReceipt(this.dataset.id)" 
                                            class="w-8 h-8 rounded-lg border border-[var(--border-color)] hover:border-blue-500 text-[var(--text-muted)] hover:text-blue-500 flex items-center justify-center text-xs" 
                                            title="Edit Struk">
                                        <i class="fa-solid fa-pen-to-square"></i>
                                    </button>
                                    <button type="button" 
                                            data-id="${escapeHtml(r.receiptId)}" 
                                            data-merchant="${escapeHtml(r.merchant)}"
                                            onclick="openDeleteConfirmModal(this.dataset.id, this.dataset.merchant)" 
                                            class="w-8 h-8 rounded-lg border border-[var(--border-color)] hover:border-rose-500 text-[var(--text-muted)] hover:text-rose-500 flex items-center justify-center text-xs" 
                                            title="Hapus Struk">
                                        <i class="fa-solid fa-trash-can"></i>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- Daftar Item Barang dalam Struk -->
                        <div class="bg-[var(--bg-surface)] p-3 rounded-xl border border-[var(--border-color)] space-y-1.5">
                            <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] block mb-1">Rincian Barang (${itemsCount} Item)</span>
                            <div class="space-y-1 text-xs">
                                ${(r.items || []).map(it => {
                                    const itCat = state.masterCategories.find(c => c.id === it.masterCategoryId || c.sheetName === it.sheetName || c.sheetName === it.masterSheetName);
                                    const itColor = itCat ? itCat.color : catObj.color;
                                    const isMultiReceipt = r.masterCategoryId === 'all' || r.masterCategoryId === 'multi';
                                    return `
                                    <div class="flex items-center justify-between py-1 border-b border-[var(--border-color)]/50 last:border-0">
                                        <div class="flex items-center gap-2 truncate">
                                            ${it.itemPhotoUrl ? `
                                                <button type="button" 
                                                        data-name="${escapeHtml(it.itemName)}" 
                                                        data-photo="${escapeHtml(it.itemPhotoUrl)}"
                                                        onclick="openPhotoPreviewModal(this.dataset.name, this.dataset.photo)" 
                                                        class="w-6 h-6 rounded-md overflow-hidden border border-[var(--border-color)] shrink-0 group relative hover:opacity-80 transition shadow-2xs" 
                                                        title="Lihat Foto ${escapeHtml(it.itemName)}">
                                                    <img src="${it.itemPhotoUrl}" class="w-full h-full object-cover">
                                                </button>
                                            ` : `
                                                <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" style="background-color: ${itColor};"></span>
                                            `}
                                            <span class="font-semibold text-[var(--text-main)] truncate">${escapeHtml(it.itemName)}</span>
                                            ${isMultiReceipt && itCat ? `
                                                <span class="text-[9px] font-bold px-1.5 py-0.2 rounded-full flex-shrink-0" style="background-color: ${hexToRgba(itCat.color, 0.15)}; color: ${itCat.color};">
                                                    ${escapeHtml(itCat.name)}
                                                </span>
                                            ` : ''}
                                            <span class="text-[10px] text-[var(--text-muted)] flex-shrink-0">x${it.qty || 1}</span>
                                        </div>
                                        <span class="font-bold text-[var(--text-main)] flex-shrink-0">${formatRupiah(it.cost)}</span>
                                    </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>

                        <!-- Ringkasan Finansial: Subtotal, Diskon, Pajak, Lainnya/Other -->
                        ${(r.totalDiscount > 0 || r.totalTax > 0 || (r.totalOther && r.totalOther !== 0)) ? `
                            <div class="flex items-center justify-between gap-2 flex-wrap pt-1.5 border-t border-[var(--border-color)]/60 text-[11px]">
                                <span class="text-[var(--text-muted)]">Subtotal Barang: <b>${formatRupiah(r.totalCost || r.subtotal || 0)}</b></span>
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    ${r.totalDiscount > 0 ? `<span class="px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 font-bold border border-emerald-500/20"><i class="fa-solid fa-tag text-[10px] mr-1"></i>-${formatRupiah(r.totalDiscount)}</span>` : ''}
                                    ${r.totalTax > 0 ? `<span class="px-2 py-0.5 rounded-md bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 font-bold border border-rose-500/20"><i class="fa-solid fa-receipt text-[10px] mr-1"></i>+${formatRupiah(r.totalTax)}</span>` : ''}
                                    ${(r.totalOther && r.totalOther !== 0) ? `<span class="px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-bold border border-blue-500/20" title="Biaya Lainnya / Layanan / Ongkir / Pembulatan"><i class="fa-solid fa-plus-minus text-[10px] mr-1"></i>Lainnya: ${r.totalOther > 0 ? '+' : ''}${formatRupiah(r.totalOther)}</span>` : ''}
                                </div>
                            </div>
                        ` : ''}
                    </div>
                `;
            });

            container.innerHTML = html;
        }

        function duplicateReceipt(receiptId) {
            const receipt = state.receipts.find(r => r.receiptId === receiptId);
            if (!receipt) return;

            setAppMode('input', 'manual');

            // Kosongkan editReceiptId agar disimpan sebagai transaksi baru (bukan menimpa)
            const editId = document.getElementById('editReceiptId');
            if (editId) editId.value = '';

            document.getElementById('formMerchant').value = receipt.merchant || '';
            // Tanggal otomatis hari ini untuk pembelian baru serupa
            const now = new Date();
            document.getElementById('formDate').value = formatToStrictDateString(now);
            document.getElementById('formDiscount').value = formatThousand(receipt.totalDiscount || receipt.discount || 0);
            document.getElementById('formTax').value = formatThousand(receipt.totalTax || receipt.tax || 0);

            const otherInp = document.getElementById('formOther');
            if (otherInp) {
                otherInp.value = formatSignedThousand(receipt.totalOther || receipt.other || 0);
            }

            const subtotalInp = document.getElementById('formSubtotalDisplay');
            if (subtotalInp) {
                subtotalInp.value = formatThousand(receipt.subtotal || receipt.totalCost || 0);
            }

            const formTitle = document.getElementById('formTitle');
            if (formTitle) formTitle.innerText = `Catat Pembelian Serupa (${receipt.merchant || 'Transaksi'})`;

            // Foto struk dikosongkan karena ini struk transaksi baru
            updateFormReceiptPhotoDisplay('');

            const catSelect = document.getElementById('formMasterCategorySelect');
            const targetCat = receipt.masterCategoryId || 'all';
            if (catSelect) {
                catSelect.value = targetCat;
                handleFormCategoryChange(targetCat);
            }

            const container = document.getElementById('formItemsContainer');
            if (container) container.innerHTML = '';
            state.formItemIndexCounter = 0;

            if (receipt.items && receipt.items.length > 0) {
                receipt.items.forEach(it => addNewItemRow(it));
            }

            updateItemCountBadge();
            calculateFormGrandTotal(false);
            updateTransactionFormModeUI();
            showToast("Data transaksi dimuat untuk pembelian baru serupa.", "info", 2500);

            const formSec = document.getElementById('transactionForm');
            if (formSec) formSec.scrollIntoView({ behavior: 'smooth' });
        }

        function editReceipt(receiptId) {
            const receipt = state.receipts.find(r => r.receiptId === receiptId);
            if (!receipt) return;

            setAppMode('input', 'manual');

            document.getElementById('editReceiptId').value = receipt.receiptId;
            document.getElementById('formMerchant').value = receipt.merchant || '';
            document.getElementById('formDate').value = formatToStrictDateString(receipt.date);
            document.getElementById('formDiscount').value = formatThousand(receipt.totalDiscount || receipt.discount || 0);
            document.getElementById('formTax').value = formatThousand(receipt.totalTax || receipt.tax || 0);

            const otherInp = document.getElementById('formOther');
            if (otherInp) {
                otherInp.value = formatSignedThousand(receipt.totalOther || receipt.other || 0);
            }

            const subtotalInp = document.getElementById('formSubtotalDisplay');
            if (subtotalInp) {
                subtotalInp.value = formatThousand(receipt.subtotal || receipt.totalCost || 0);
            }

            updateFormReceiptPhotoDisplay(receipt.receiptPhotoUrl || '');

            const catSelect = document.getElementById('formMasterCategorySelect');
            const targetCat = receipt.masterCategoryId || 'all';
            if (catSelect) {
                catSelect.value = targetCat;
                handleFormCategoryChange(targetCat);
            }

            const container = document.getElementById('formItemsContainer');
            if (container) container.innerHTML = '';
            state.formItemIndexCounter = 0;

            if (receipt.items && receipt.items.length > 0) {
                receipt.items.forEach(it => addNewItemRow(it));
            }

            updateItemCountBadge();
            calculateFormGrandTotal(false);
            updateTransactionFormModeUI(receipt);
            showToast("Struk dimuat untuk pengeditan dalam Mode Edit.");

            const formSec = document.getElementById('transactionForm');
            if (formSec) formSec.scrollIntoView({ behavior: 'smooth' });
        }

        function openDeleteConfirmModal(receiptId, merchant) {
            state.pendingDeleteReceiptId = receiptId;
            const desc = document.getElementById('deleteReceiptDesc');
            if (desc) desc.innerText = `Yakin ingin menghapus seluruh data struk ${receiptId} (${merchant})?`;

            const modal = document.getElementById('deleteConfirmModal');
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        }
        function closeDeleteConfirmModal() {
            state.pendingDeleteReceiptId = null;
            const modal = document.getElementById('deleteConfirmModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        function executeDeleteReceipt() {
            const receiptId = state.pendingDeleteReceiptId;
            if (!receiptId) return;

            const targetReceipt = state.receipts.find(r => r.receiptId === receiptId);
            const sheetName = targetReceipt ? targetReceipt.masterSheetName : "";

            closeDeleteConfirmModal();

            // Backup untuk rollback jika transmisi gagal
            const backupReceipt = targetReceipt ? { ...targetReceipt } : null;
            const backupEntries = state.entries.filter(e => e.receiptId === receiptId);

            // Optimistic deletion (0ms latency feel)
            state.receipts = state.receipts.filter(r => r.receiptId !== receiptId);
            state.entries = state.entries.filter(e => e.receiptId !== receiptId);
            renderDashboard();
            filterHistoryList();
            showToast("Struk dihapus (menyinkronkan ke Cloud...)", "info", 2500);

            if (typeof google !== 'undefined' && google.script && google.script.run) {
                google.script.run
                    .withSuccessHandler(function(resp) {
                        if (resp && resp.success) {
                            showToast("Struk berhasil dihapus dari Google Sheets.", "success");
                        } else {
                            if (backupReceipt) state.receipts = [backupReceipt, ...state.receipts];
                            state.entries = [...backupEntries, ...state.entries];
                            renderDashboard();
                            filterHistoryList();
                            showToast("Gagal menghapus di cloud: " + (resp ? resp.message : "Error"), "error", 5000);
                        }
                    })
                    .withFailureHandler(function(err) {
                        if (backupReceipt) state.receipts = [backupReceipt, ...state.receipts];
                        state.entries = [...backupEntries, ...state.entries];
                        renderDashboard();
                        filterHistoryList();
                        showToast("Gagal menghapus struk: " + (err.message || err), "error", 5000);
                    })
                    .deleteTransactionFromSheet(sheetName, receiptId, (state.currentUser && state.currentUser.customSpreadsheetId) || "");
            } else {
                // Standalone local deletion
                saveMockData(state.entries, state.receipts);
                showToast("Struk berhasil dihapus dari memori lokal.", "success");
            }
        }

        function exportHistoryToCsv() {
            if (state.entries.length === 0) {
                showToast("Tidak ada data untuk diexport!");
                return;
            }

            const headers = ["Timestamp", "Date", "ReceiptID", "Merchant", "ItemName", "SubCategory", "Qty", "Cost", "Discount", "Tax", "Other", "MasterCategory"];
            const rows = state.entries.map(e => [
                `"${e.timestamp || ''}"`,
                `"${e.date || ''}"`,
                `"${e.receiptId || ''}"`,
                `"${(e.merchant || '').replace(/"/g, '""')}"`,
                `"${(e.itemName || '').replace(/"/g, '""')}"`,
                `"${(e.subCategory || '').replace(/"/g, '""')}"`,
                e.qty || 1,
                e.cost || 0,
                e.discount || 0,
                e.tax || 0,
                e.other || 0,
                `"${(e.masterCategoryName || '').replace(/"/g, '""')}"`
            ]);

            const csvContent = "data:text/csv;charset=utf-8," + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", `Saturuma_Transaksi_${new Date().toISOString().split('T')[0]}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            showToast("CSV berhasil diunduh!");
        }

        /* ========================================================
           MODAL & CONTROLLER: LAPORAN BULANAN KELUARGA (PDF / PRINT PREVIEW)
           ======================================================== */
        const MONTH_NAMES_ID = [
            "Januari", "Februari", "Maret", "April", "Mei", "Juni",
            "Juli", "Agustus", "September", "Oktober", "November", "Desember"
        ];

        function formatMonthYearLabel(ym) {
            if (!ym || typeof ym !== 'string' || !ym.includes('-')) return ym || '';
            const parts = ym.split('-');
            const year = parts[0];
            const monthIdx = parseInt(parts[1], 10) - 1;
            return `${MONTH_NAMES_ID[monthIdx] || parts[1]} ${year}`;
        }

        function getAvailableReportMonths() {
            const monthSet = new Set();
            const now = new Date();
            const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            monthSet.add(curYM);

            (state.entries || []).forEach(e => {
                if (e && e.date && e.date.length >= 7) {
                    monthSet.add(e.date.substring(0, 7));
                }
            });

            (state.receipts || []).forEach(r => {
                if (r && r.date && r.date.length >= 7) {
                    monthSet.add(r.date.substring(0, 7));
                }
            });

            return Array.from(monthSet).sort().reverse();
        }

        function openMonthlyReportModal() {
            const modal = document.getElementById('monthlyReportModal');
            if (!modal) return;

            const select = document.getElementById('reportMonthSelect');
            const availableMonths = getAvailableReportMonths();

            if (select) {
                select.innerHTML = availableMonths.map(ym => `<option value="${ym}">${formatMonthYearLabel(ym)}</option>`).join('');
                const now = new Date();
                const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                if (availableMonths.includes(curYM)) {
                    select.value = curYM;
                } else if (availableMonths.length > 0) {
                    select.value = availableMonths[0];
                }
            }

            const activeMonth = select ? select.value : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
            renderMonthlyReportPreview(activeMonth);

            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeMonthlyReportModal() {
            const modal = document.getElementById('monthlyReportModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        function handleReportMonthChange(valOrEvent) {
            let selectedMonth = valOrEvent;
            if (valOrEvent && typeof valOrEvent === 'object') {
                if (valOrEvent.target && valOrEvent.target.value) {
                    selectedMonth = valOrEvent.target.value;
                } else if (valOrEvent.value) {
                    selectedMonth = valOrEvent.value;
                }
            }
            if (!selectedMonth || typeof selectedMonth !== 'string') {
                const sel = document.getElementById('reportMonthSelect');
                if (sel) selectedMonth = sel.value;
            }
            renderMonthlyReportPreview(selectedMonth);
        }

        function printMonthlyReport() {
            const select = document.getElementById('reportMonthSelect');
            const ym = (select && select.value) ? select.value : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
            const monthLabel = formatMonthYearLabel(ym).replace(/\s+/g, '-');
            const originalTitle = document.title;
            document.title = `Laporan-Keuangan-SatuRuma-${monthLabel}`;
            window.print();
            setTimeout(() => {
                document.title = originalTitle;
            }, 1000);
        }

        function renderMonthlyReportPreview(monthKey) {
            const container = document.getElementById('monthlyReportPrintArea');
            if (!container) return;

            try {
                if (!monthKey || typeof monthKey !== 'string') {
                    const now = new Date();
                    monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                }

                const monthLabel = formatMonthYearLabel(monthKey);

                // Filter struk dan entri pada bulan terpilih
                const monthReceipts = (state.receipts || []).filter(r => r && String(r.date || '').startsWith(monthKey));
                const monthEntries = (state.entries || []).filter(e => e && String(e.date || '').startsWith(monthKey));

                // Hitung total pengeluaran
                let totalSpent = 0;
                if (monthReceipts.length > 0) {
                    totalSpent = monthReceipts.reduce((acc, r) => acc + (Number(r.totalAmount || r.totalCost || 0)), 0);
                } else if (monthEntries.length > 0) {
                    totalSpent = monthEntries.reduce((acc, e) => acc + (Number(e.cost || 0) * Number(e.qty || 1)), 0);
                }

                // Total diskon, pajak, dan biaya lainnya yang didapat
                const totalDiscount = monthReceipts.reduce((acc, r) => acc + (Number(r.totalDiscount || r.discount || 0)), 0);
                const totalTax = monthReceipts.reduce((acc, r) => acc + (Number(r.totalTax || r.tax || 0)), 0);
                const totalOther = monthReceipts.reduce((acc, r) => acc + (Number(r.totalOther || r.other || 0)), 0);

                // Anggaran bulanan
                const monthlyBudget = (typeof getTotalCategoryBudgets === 'function') ? getTotalCategoryBudgets() : ((state.stats && state.stats.monthlyBudget) || 10000000);
                const remainingBudget = Math.max(0, monthlyBudget - totalSpent);
                const budgetUsagePct = monthlyBudget > 0 ? Math.round((totalSpent / monthlyBudget) * 100) : 0;

                // Rincian per Master Kategori
                const catSummary = {};
                (state.masterCategories || []).forEach(cat => {
                    if (!cat) return;
                    const catBudget = (typeof getCategoryBudget === 'function') ? getCategoryBudget(cat.id) : 0;
                    catSummary[cat.id] = {
                        id: cat.id,
                        name: cat.name || 'Umum',
                        color: cat.color || '#10B981',
                        icon: cat.icon || 'fa-folder',
                        budget: Number(catBudget) || 0,
                        spent: 0,
                        receiptsCount: 0,
                        itemsCount: 0
                    };
                });

                // Agregasi dari receipts
                monthReceipts.forEach(r => {
                    const cId = r.masterCategoryId || 'all';
                    if (!catSummary[cId]) {
                        catSummary[cId] = {
                            id: cId,
                            name: r.masterCategoryName || (cId === 'all' ? 'Multi-Modul' : 'Lainnya'),
                            color: '#64748B',
                            icon: 'fa-folder',
                            budget: 0,
                            spent: 0,
                            receiptsCount: 0,
                            itemsCount: 0
                        };
                    }
                    catSummary[cId].spent += (Number(r.totalAmount || r.totalCost || 0));
                    catSummary[cId].receiptsCount += 1;
                });

                // Agregasi item count dari entries
                monthEntries.forEach(e => {
                    const cId = e.masterCategoryId || 'all';
                    if (catSummary[cId]) {
                        catSummary[cId].itemsCount += (Number(e.qty || 1));
                        if (monthReceipts.length === 0) {
                            catSummary[cId].spent += (Number(e.cost || 0) * Number(e.qty || 1));
                        }
                    }
                });

                // Agregasi merchant / toko teratas
                const merchantMap = {};
                monthReceipts.forEach(r => {
                    const m = String(r.merchant || 'Lainnya').trim();
                    if (!merchantMap[m]) merchantMap[m] = { name: m, count: 0, total: 0 };
                    merchantMap[m].count += 1;
                    merchantMap[m].total += (Number(r.totalAmount || r.totalCost || 0));
                });
                const topMerchants = Object.values(merchantMap).sort((a, b) => b.total - a.total).slice(0, 5);

                // Waktu cetak
                const now = new Date();
                const printDateStr = `${now.getDate()} ${MONTH_NAMES_ID[now.getMonth()]} ${now.getFullYear()}, ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} WIB`;
                const profileName = (state.currentUser && (state.currentUser.name || state.currentUser.username || state.currentUser.email)) || "Keluarga SatuRuma";

                // Urutkan struk berdasarkan tanggal terbaru
                const sortedReceipts = [...monthReceipts].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

            // Bangun Template HTML
            container.innerHTML = `
                <div class="bg-white text-slate-900 p-6 sm:p-8 rounded-2xl shadow-sm border border-slate-200 space-y-6 text-sm font-sans print:p-0 print:border-none print:shadow-none print:rounded-none">
                    
                    <!-- 1. KOP SURAT / HEADER LAPORAN -->
                    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b-2 border-slate-900">
                        <div class="flex items-center gap-3">
                            <div class="saturuma-brand-badge w-12 h-12 rounded-2xl shrink-0 print:border print:border-rose-200">
                                <img src="icons/user-logo.png" alt="Saturuma Logo" class="brand-logo-img">
                            </div>
                            <div>
                                <h1 class="text-xl sm:text-2xl font-black tracking-tight text-slate-900 leading-none">SATURUMA</h1>
                                <p class="text-xs font-semibold text-slate-600 mt-1">Laporan Keuangan &amp; Pengeluaran Rumah Tangga</p>
                                <p class="text-[11px] text-slate-500 mt-0.5">Profil: <b class="text-slate-800">${escapeHtml(profileName)}</b></p>
                            </div>
                        </div>

                        <div class="text-left sm:text-right">
                            <span class="inline-block px-3 py-1 rounded-lg bg-rose-50 text-rose-700 font-extrabold text-xs tracking-wider uppercase border border-rose-200 mb-1">
                                PERIODE: ${escapeHtml(monthLabel)}
                            </span>
                            <p class="text-[11px] text-slate-500">Dicetak: ${printDateStr}</p>
                        </div>
                    </div>

                    <!-- 2. RINGKASAN EKSEKUTIF (KPI CARDS) -->
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div class="p-4 rounded-xl bg-slate-50 border border-slate-200">
                            <span class="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">Total Pengeluaran</span>
                            <span class="text-base sm:text-lg font-black text-rose-600 block mt-1">${formatRupiah(totalSpent)}</span>
                            <span class="text-[10px] text-slate-500 mt-0.5 block">${monthReceipts.length} struk tercatat</span>
                        </div>
                        <div class="p-4 rounded-xl bg-slate-50 border border-slate-200">
                            <span class="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">Anggaran Bulanan</span>
                            <span class="text-base sm:text-lg font-black text-slate-800 block mt-1">${formatRupiah(monthlyBudget)}</span>
                            <span class="text-[10px] ${totalSpent > monthlyBudget ? 'text-rose-600 font-bold' : 'text-emerald-600 font-semibold'} mt-0.5 block">
                                ${totalSpent > monthlyBudget ? `Overbudget (+${budgetUsagePct - 100}%)` : `Sisa ${formatRupiah(remainingBudget)} (${budgetUsagePct}%)`}
                            </span>
                        </div>
                        <div class="p-4 rounded-xl bg-slate-50 border border-slate-200">
                            <span class="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">Total Diskon / Hemat</span>
                            <span class="text-base sm:text-lg font-black text-emerald-600 block mt-1">${formatRupiah(totalDiscount)}</span>
                            <span class="text-[10px] text-slate-500 mt-0.5 block">Dari promo &amp; potongan struk</span>
                        </div>
                        <div class="p-4 rounded-xl bg-slate-50 border border-slate-200">
                            <span class="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">Aktivitas Belanja</span>
                            <span class="text-base sm:text-lg font-black text-slate-800 block mt-1">${monthEntries.length} Item</span>
                            <span class="text-[10px] text-slate-500 mt-0.5 block">Rata-rata: ${monthReceipts.length > 0 ? formatRupiah(Math.round(totalSpent / monthReceipts.length)) : 'Rp 0'}/struk</span>
                        </div>
                    </div>

                    <!-- 3. RINCIAN PENGELUARAN PER MODUL KATEGORI -->
                    <div class="space-y-2.5">
                        <h2 class="text-xs sm:text-sm font-extrabold uppercase tracking-wider text-slate-800 flex items-center gap-2">
                            <i class="fa-solid fa-chart-pie text-rose-500"></i>
                            <span>Distribusi Pengeluaran per Modul Kategori</span>
                        </h2>

                        <div class="overflow-x-auto border border-slate-200 rounded-xl">
                            <table class="w-full text-left text-xs border-collapse">
                                <thead>
                                    <tr class="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
                                        <th class="p-2.5">Modul Kategori</th>
                                        <th class="p-2.5 text-right">Anggaran</th>
                                        <th class="p-2.5 text-right">Realisasi (Rp)</th>
                                        <th class="p-2.5 text-right">% Anggaran</th>
                                        <th class="p-2.5 text-right">Porsi Belanja</th>
                                        <th class="p-2.5 text-center">Status</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-slate-100">
                                    ${Object.values(catSummary).map(cat => {
                                        const porsiPct = totalSpent > 0 ? Math.round((cat.spent / totalSpent) * 100) : 0;
                                        const budgetPct = cat.budget > 0 ? Math.round((cat.spent / cat.budget) * 100) : 0;
                                        const isOver = cat.budget > 0 && cat.spent > cat.budget;
                                        return `
                                            <tr class="hover:bg-slate-50/80">
                                                <td class="p-2.5 font-bold text-slate-800 flex items-center gap-2">
                                                    <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${cat.color};"></span>
                                                    <span>${escapeHtml(cat.name)}</span>
                                                    <span class="text-[10px] text-slate-400 font-normal">(${cat.receiptsCount} struk)</span>
                                                </td>
                                                <td class="p-2.5 text-right text-slate-600">${formatRupiah(cat.budget)}</td>
                                                <td class="p-2.5 text-right font-black text-slate-900">${formatRupiah(cat.spent)}</td>
                                                <td class="p-2.5 text-right font-semibold ${isOver ? 'text-rose-600' : 'text-slate-600'}">${cat.budget > 0 ? `${budgetPct}%` : '-'}</td>
                                                <td class="p-2.5 text-right font-semibold text-slate-700">${porsiPct}%</td>
                                                <td class="p-2.5 text-center">
                                                    <span class="inline-block px-2 py-0.5 text-[10px] font-bold rounded-full ${isOver ? 'bg-rose-100 text-rose-700' : (cat.spent > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600')}">
                                                        ${isOver ? 'Melebihi' : (cat.spent > 0 ? 'Sesuai' : 'Belum Ada')}
                                                    </span>
                                                </td>
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- 4. TOP 5 TOKO / MERCHANT TERBANYAK -->
                    ${topMerchants.length > 0 ? `
                        <div class="space-y-2.5">
                            <h2 class="text-xs sm:text-sm font-extrabold uppercase tracking-wider text-slate-800 flex items-center gap-2">
                                <i class="fa-solid fa-store text-rose-500"></i>
                                <span>Toko / Tempat Belanja Terbanyak (${topMerchants.length} Toko)</span>
                            </h2>
                            <div class="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                                ${topMerchants.map((m, idx) => `
                                    <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
                                        <div class="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 mb-1">
                                            <span>#${idx + 1}</span>
                                            <span>•</span>
                                            <span>${m.count}x belanja</span>
                                        </div>
                                        <div class="font-bold text-xs text-slate-900 truncate" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
                                        <div class="font-black text-xs text-slate-700 mt-1">${formatRupiah(m.total)}</div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}

                    <!-- 5. DAFTAR STRUK BELANJA BULANAN -->
                    <div class="space-y-2.5">
                        <div class="flex items-center justify-between gap-2">
                            <h2 class="text-xs sm:text-sm font-extrabold uppercase tracking-wider text-slate-800 flex items-center gap-2">
                                <i class="fa-solid fa-receipt text-rose-500"></i>
                                <span>Rincian Struk &amp; Pembelian (${sortedReceipts.length} Struk)</span>
                            </h2>
                        </div>

                        ${sortedReceipts.length === 0 ? `
                            <div class="p-6 text-center border border-dashed border-slate-300 rounded-xl text-slate-500 text-xs">
                                <i class="fa-solid fa-receipt text-3xl opacity-30 block mb-2"></i>
                                <span>Belum ada transaksi struk belanja tercatat pada periode <b>${escapeHtml(monthLabel)}</b>.</span>
                            </div>
                        ` : `
                            <div class="overflow-x-auto border border-slate-200 rounded-xl">
                                <table class="w-full text-left text-xs border-collapse">
                                    <thead>
                                        <tr class="bg-slate-100 text-slate-700 font-bold border-b border-slate-200">
                                            <th class="p-2.5 w-10 text-center">No</th>
                                            <th class="p-2.5">Tanggal</th>
                                            <th class="p-2.5">Toko / Merchant</th>
                                            <th class="p-2.5">Modul Kategori</th>
                                            <th class="p-2.5">Rincian Barang</th>
                                            <th class="p-2.5 text-right">Diskon</th>
                                            <th class="p-2.5 text-right">Pajak</th>
                                            <th class="p-2.5 text-right">Lainnya</th>
                                            <th class="p-2.5 text-right">Total Struk</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-slate-100">
                                        ${sortedReceipts.map((r, i) => {
                                            const cat = (state.masterCategories || []).find(c => c && (c.id === r.masterCategoryId || c.sheetName === r.masterCategoryId)) || { name: r.masterCategoryName || (r.masterCategoryId === 'all' ? 'Multi-Modul' : 'Umum'), color: '#64748B' };
                                            
                                            let itemsSummary = '';
                                            if (Array.isArray(r.items) && r.items.length > 0) {
                                                itemsSummary = r.items.map(it => {
                                                    if (!it) return '';
                                                    if (typeof it === 'string') return it;
                                                    const name = it.itemName || it.name || '';
                                                    const q = it.qty || 1;
                                                    return `${name} (${q}x)`;
                                                }).filter(Boolean).join(', ');
                                            } else if (typeof r.items === 'string' && r.items.trim()) {
                                                try {
                                                    const parsed = JSON.parse(r.items);
                                                    if (Array.isArray(parsed)) {
                                                        itemsSummary = parsed.map(it => `${it.itemName || it.name || ''} (${it.qty || 1}x)`).join(', ');
                                                    } else {
                                                        itemsSummary = r.items;
                                                    }
                                                } catch(e) {
                                                    itemsSummary = r.items;
                                                }
                                            }
                                            if (!itemsSummary) {
                                                itemsSummary = `${r.itemsCount || 1} item belanja`;
                                            }

                                            const disc = Number(r.totalDiscount || r.discount || 0);
                                            const tax = Number(r.totalTax || r.tax || 0);
                                            const other = Number(r.totalOther || r.other || 0);
                                            const total = Number(r.totalAmount || r.totalCost || 0);

                                            return `
                                                <tr class="hover:bg-slate-50/80">
                                                    <td class="p-2.5 text-center text-slate-400 font-semibold">${i + 1}</td>
                                                    <td class="p-2.5 font-bold text-slate-700 whitespace-nowrap">${r.date || '-'}</td>
                                                    <td class="p-2.5 font-bold text-slate-900">${escapeHtml(r.merchant || '-')}</td>
                                                    <td class="p-2.5">
                                                        <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold text-white shadow-2xs" style="background-color: ${cat.color || '#64748B'};">
                                                            ${escapeHtml(cat.name || 'Umum')}
                                                        </span>
                                                    </td>
                                                    <td class="p-2.5 text-slate-600 max-w-xs truncate" title="${escapeHtml(itemsSummary)}">
                                                        ${escapeHtml(itemsSummary)}
                                                    </td>
                                                    <td class="p-2.5 text-right text-emerald-600 font-semibold whitespace-nowrap">
                                                        ${disc > 0 ? `-${formatRupiah(disc)}` : '-'}
                                                    </td>
                                                    <td class="p-2.5 text-right text-rose-500 font-semibold whitespace-nowrap">
                                                        ${tax > 0 ? `+${formatRupiah(tax)}` : '-'}
                                                    </td>
                                                    <td class="p-2.5 text-right text-blue-600 font-semibold whitespace-nowrap">
                                                        ${other !== 0 ? (other > 0 ? `+${formatRupiah(other)}` : `-${formatRupiah(Math.abs(other))}`) : '-'}
                                                    </td>
                                                    <td class="p-2.5 text-right font-black text-slate-900 whitespace-nowrap">
                                                        ${formatRupiah(total)}
                                                    </td>
                                                </tr>
                                            `;
                                        }).join('')}
                                    </tbody>
                                    <tfoot>
                                        <tr class="bg-slate-100 font-black text-slate-900 border-t-2 border-slate-300">
                                            <td colspan="5" class="p-2.5 text-right uppercase tracking-wider">Grand Total Pengeluaran Bulan Ini:</td>
                                            <td class="p-2.5 text-right text-emerald-600">${totalDiscount > 0 ? `-${formatRupiah(totalDiscount)}` : '-'}</td>
                                            <td class="p-2.5 text-right text-rose-500">${totalTax > 0 ? `+${formatRupiah(totalTax)}` : '-'}</td>
                                            <td class="p-2.5 text-right text-blue-600">${totalOther !== 0 ? (totalOther > 0 ? `+${formatRupiah(totalOther)}` : `-${formatRupiah(Math.abs(totalOther))}`) : '-'}</td>
                                            <td class="p-2.5 text-right text-rose-600 text-sm">${formatRupiah(totalSpent)}</td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        `}
                    </div>

                    <!-- 6. LEMBAR PENGESAHAN & TANDA TANGAN -->
                    <div class="pt-6 border-t border-slate-200 grid grid-cols-2 gap-8 text-center text-xs">
                        <div>
                            <p class="text-slate-500 font-medium">Dicatat &amp; Diverifikasi oleh,</p>
                            <div class="h-16"></div>
                            <p class="font-bold text-slate-800 border-t border-dashed border-slate-300 pt-1 inline-block min-w-[140px]">
                                ${escapeHtml(profileName)}
                            </p>
                        </div>
                        <div>
                            <p class="text-slate-500 font-medium">Kepala Keluarga / Pasangan,</p>
                            <div class="h-16"></div>
                            <p class="font-bold text-slate-800 border-t border-dashed border-slate-300 pt-1 inline-block min-w-[140px]">
                                ( ....................................... )
                            </p>
                        </div>
                    </div>

                    <!-- 7. FOOTNOTE RESMI -->
                    <div class="pt-4 border-t border-slate-100 text-center text-[10px] text-slate-400">
                        <span>Laporan ini dihasilkan otomatis oleh SatuRuma App • Sistem Manajemen Belanja &amp; Finansial Rumah Tangga</span>
                    </div>

                </div>
            `;
            } catch (err) {
                console.error("Error renderMonthlyReportPreview:", err);
                container.innerHTML = `
                    <div class="p-8 text-center bg-white dark:bg-slate-800 rounded-2xl border border-rose-200 dark:border-rose-900/50 text-rose-600 space-y-2">
                        <i class="fa-solid fa-circle-exclamation text-3xl"></i>
                        <h4 class="font-bold text-sm">Terjadi kendala saat memuat laporan</h4>
                        <p class="text-xs text-slate-500 dark:text-slate-400 font-mono">${escapeHtml(err.message || String(err))}</p>
                    </div>
                `;
            }
        }

        /* ========================================================
           MODAL & CONTROLLER: RIWAYAT HARGA BARANG & DETEKSI INFLASI TOKO
           ======================================================== */
        function openItemPriceHistoryModal(itemName) {
            const modal = document.getElementById('itemPriceHistoryModal');
            if (!modal) return;

            const titleEl = document.getElementById('priceHistoryItemName');
            if (titleEl) titleEl.innerText = itemName || "Semua Barang";

            const contentEl = document.getElementById('priceHistoryContent');
            if (!contentEl) return;

            const searchName = (itemName || '').trim().toLowerCase();

            const matchedEntries = (state.entries || []).filter(e => {
                if (!e || !e.itemName) return false;
                if (!searchName) return true;
                return e.itemName.toLowerCase().includes(searchName);
            });

            matchedEntries.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

            if (matchedEntries.length === 0) {
                contentEl.innerHTML = `
                    <div class="p-8 text-center text-xs text-[var(--text-muted)] space-y-2">
                        <i class="fa-solid fa-chart-line text-3xl opacity-30 block mb-2"></i>
                        <p class="font-bold text-[var(--text-main)]">Belum Ada Riwayat Belanja</p>
                        <p>Data pembelian untuk barang "<b>${escapeHtml(itemName || '')}</b>" belum ditemukan dalam riwayat transaksi.</p>
                    </div>
                `;
            } else {
                const prices = matchedEntries.map(e => Number(e.cost || 0)).filter(p => p > 0);
                const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
                const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
                const latestPrice = prices.length > 0 ? prices[0] : 0;
                const oldestPrice = prices.length > 0 ? prices[prices.length - 1] : 0;

                let priceTrendBadge = '';
                if (prices.length > 1) {
                    const diff = latestPrice - oldestPrice;
                    const pct = oldestPrice > 0 ? Math.round((diff / oldestPrice) * 100) : 0;
                    if (diff > 0) {
                        priceTrendBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-500/10 text-rose-500 border border-rose-500/20"><i class="fa-solid fa-arrow-trend-up mr-1"></i>+${pct}% (Inflasi / Naik)</span>`;
                    } else if (diff < 0) {
                        priceTrendBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"><i class="fa-solid fa-arrow-trend-down mr-1"></i>${pct}% (Turun / Hemat)</span>`;
                    } else {
                        priceTrendBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-500/10 text-slate-500 border border-slate-500/20"><i class="fa-solid fa-minus mr-1"></i>Stabil</span>`;
                    }
                }

                let html = `
                    <div class="grid grid-cols-3 gap-2 text-center">
                        <div class="p-2.5 rounded-2xl bg-[var(--bg-main)] border border-[var(--border-color)]">
                            <span class="text-[10px] text-[var(--text-muted)] block font-semibold">Harga Terakhir</span>
                            <span class="text-xs font-black text-[var(--text-main)] block mt-0.5">${formatRupiah(latestPrice)}</span>
                        </div>
                        <div class="p-2.5 rounded-2xl bg-[var(--bg-main)] border border-[var(--border-color)]">
                            <span class="text-[10px] text-[var(--text-muted)] block font-semibold">Harga Terendah</span>
                            <span class="text-xs font-black text-emerald-600 block mt-0.5">${formatRupiah(minPrice)}</span>
                        </div>
                        <div class="p-2.5 rounded-2xl bg-[var(--bg-main)] border border-[var(--border-color)]">
                            <span class="text-[10px] text-[var(--text-muted)] block font-semibold">Harga Tertinggi</span>
                            <span class="text-xs font-black text-rose-600 block mt-0.5">${formatRupiah(maxPrice)}</span>
                        </div>
                    </div>

                    ${priceTrendBadge ? `
                        <div class="flex items-center justify-between p-2.5 rounded-xl bg-[var(--bg-main)] border border-[var(--border-color)] text-xs">
                            <span class="font-bold text-[var(--text-muted)] text-[11px]">Tren Perubahan Harga:</span>
                            ${priceTrendBadge}
                        </div>
                    ` : ''}

                    <div class="space-y-2">
                        <h4 class="text-xs font-bold text-[var(--text-main)] flex items-center justify-between">
                            <span>Log Pembelian (${matchedEntries.length}x transaksi)</span>
                        </h4>
                        <div class="divide-y divide-[var(--border-color)] border border-[var(--border-color)] rounded-2xl overflow-hidden bg-[var(--bg-surface)]">
                `;

                matchedEntries.forEach(entry => {
                    const formattedDate = entry.date || '-';
                    html += `
                        <div class="p-3 flex items-center justify-between gap-3 text-xs hover:bg-[var(--bg-main)] transition-colors">
                            <div class="min-w-0">
                                <div class="font-bold text-[var(--text-main)] truncate">${escapeHtml(entry.merchant || 'Toko Tidak Dikenal')}</div>
                                <div class="text-[10px] text-[var(--text-muted)] flex items-center gap-1.5 mt-0.5">
                                    <span><i class="fa-regular fa-calendar text-[10px]"></i> ${formattedDate}</span>
                                    <span>•</span>
                                    <span>${entry.qty || 1} unit</span>
                                    ${entry.subCategory ? `<span>•</span><span>${escapeHtml(entry.subCategory)}</span>` : ''}
                                </div>
                            </div>
                            <div class="text-right flex-shrink-0">
                                <span class="font-black text-xs text-[var(--text-main)] block">${formatRupiah(entry.cost)}</span>
                                ${(entry.qty > 1) ? `<span class="text-[10px] text-[var(--text-muted)] block">Total: ${formatRupiah((entry.cost || 0) * (entry.qty || 1))}</span>` : ''}
                            </div>
                        </div>
                    `;
                });

                html += `
                        </div>
                    </div>
                `;

                contentEl.innerHTML = html;
            }

            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeItemPriceHistoryModal() {
            const modal = document.getElementById('itemPriceHistoryModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        /* ========================================================
           MODERN NOTIFICATION BADGE CONTROLLER
           1. Top-Right Anchoring: relative container, absolute -top-1 -right-1
           2. High-Contrast Accent: #EF4444 (bg-red-500) + teks putih
           3. Micro-Typography: 10px bold, otomatis "99+" jika angka > 99
           4. Isolated Border/Ring Effect: 2px ring-white di sekeliling badge
           + Touch target nyaman (>= 44px) & posisi stabil tanpa bergeser
           ======================================================== */
        const notifBadgeState = {
            simulatedCount: null
        };

        // Micro-Typography: Ukuran 10px Bold & Otomatis ubah angka > 99 menjadi "99+"
        function formatBadgeCount(count) {
            const num = parseInt(count, 10);
            if (isNaN(num) || num <= 0) return '';
            if (num > 99) return '99+';
            return String(num);
        }

        // Hitung total pengingat aktif yang belum diselesaikan
        function getActiveNotificationCount() {
            if (notifBadgeState.simulatedCount !== null) {
                return notifBadgeState.simulatedCount;
            }
            if (!state.reminders || !Array.isArray(state.reminders)) return 0;
            return state.reminders.filter(r => !r.completed).length;
        }

        // Menerapkan status badge (Badge notifikasi telah dihilangkan sesuai permintaan)
        function applyModernBadge(el, count) {
            if (!el) return;
            el.classList.add('hidden');
            el.innerText = '';
        }

        // Perbarui status notifikasi secara responsif
        function updateAllNotificationBadges() {
            const count = getActiveNotificationCount();

            // Sembunyikan badge jika elemen masih ada di DOM
            applyModernBadge(document.getElementById('topBarNotificationBadge'), count);
            applyModernBadge(document.getElementById('sidebarNotificationBadge'), count);
            applyModernBadge(document.getElementById('bnavNotificationBadge'), count);

            // Update status jumlah pengingat aktif di dalam popover dropdown
            const countEl = document.getElementById('notifDropdownCount');
            if (countEl) {
                countEl.innerText = `${count} Pengingat Aktif`;
            }

            renderNotificationDropdownItems();
        }

        function setNotificationBadgeMode(newMode) {
            // Deprecated: Dot Notification telah dihilangkan, badge selalu menggunakan Number Badge
            updateAllNotificationBadges();
        }

        // Simulator interaktif untuk menguji variasi angka (misal: 5, 42, 120 -> "99+", reset)
        function simulateBadgeCount(simCount) {
            notifBadgeState.simulatedCount = simCount;
            updateAllNotificationBadges();
            if (simCount !== null) {
                showToast(`Simulasi badge: ${simCount} (Tampilan: "${formatBadgeCount(simCount)}")`, "info");
            } else {
                showToast("Simulasi dinonaktifkan, kembali ke hitungan asli pengingat.", "success");
            }
        }

        // Buka / Tutup Dropdown Notifikasi
        function toggleNotificationDropdown() {
            const dropdown = document.getElementById('notificationDropdown');
            if (!dropdown) return;
            const isHidden = dropdown.classList.contains('hidden');
            if (isHidden) {
                dropdown.classList.remove('hidden');
                renderNotificationDropdownItems();
            } else {
                dropdown.classList.add('hidden');
            }
        }

        function closeNotificationDropdown() {
            const dropdown = document.getElementById('notificationDropdown');
            if (dropdown) dropdown.classList.add('hidden');
        }

        // Render isi daftar pengingat di Dropdown Popover
        function renderNotificationDropdownItems() {
            const listContainer = document.getElementById('notifDropdownList');
            if (!listContainer) return;

            const activeList = (state.reminders || []).filter(r => !r.completed);
            if (activeList.length === 0) {
                listContainer.innerHTML = `
                    <div class="p-6 text-center text-[var(--text-muted)] space-y-1">
                        <i class="fa-regular fa-bell-slash text-2xl text-slate-300 dark:text-slate-600 block mb-2"></i>
                        <p class="text-xs font-semibold text-[var(--text-main)]">Tidak ada pengingat aktif</p>
                        <p class="text-[10px]">Semua jadwal belanja & pengingat telah terselesaikan.</p>
                    </div>
                `;
                return;
            }

            let html = '';
            activeList.slice(0, 6).forEach(item => {
                const cat = (state.masterCategories || []).find(c => c.id === item.categoryId) || { name: 'Umum', color: '#64748b', icon: 'fa-tag' };
                html += `
                    <div class="dropdown-item px-4 py-2.5 rounded-lg transition-all duration-200 flex items-center justify-between gap-2.5 cursor-pointer hover:bg-[var(--primary-light)]/40 dark:hover:bg-slate-800/60">
                        <div class="flex items-center gap-2.5 min-w-0 flex-1">
                            <span class="w-7 h-7 rounded-lg flex items-center justify-center text-xs shrink-0" style="background-color: ${cat.color}20; color: ${cat.color};">
                                <i class="fa-solid ${cat.icon || 'fa-tag'}"></i>
                            </span>
                            <div class="min-w-0 flex-1">
                                <h6 class="text-xs font-bold text-[var(--text-main)] truncate">${escapeHtml(item.title || item.name || 'Pengingat')}</h6>
                                <div class="flex items-center gap-2 text-[10px] text-[var(--text-muted)] mt-0.5">
                                    <span><i class="fa-regular fa-calendar mr-1"></i>${item.date || 'Tanpa Tanggal'}</span>
                                    ${item.estCost ? `<span>&bull; ${formatRupiah(item.estCost)}</span>` : ''}
                                </div>
                            </div>
                        </div>
                        <button type="button" onclick="event.stopPropagation(); toggleReminderComplete('${item.id}'); updateAllNotificationBadges();" class="w-7 h-7 rounded-lg border border-[var(--border-color)] bg-[var(--bg-surface)] hover:bg-emerald-500 hover:text-white hover:border-emerald-500 flex items-center justify-center text-xs text-[var(--text-muted)] transition-all shrink-0" title="Tandai Selesai">
                            <i class="fa-solid fa-check"></i>
                        </button>
                    </div>
                `;
            });

            if (activeList.length > 6) {
                html += `
                    <div class="p-2 text-center bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)] font-semibold rounded-lg mx-1 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.08)]">
                        +${activeList.length - 6} pengingat lainnya
                    </div>
                `;
            }

            listContainer.innerHTML = html;
        }

        /* ========================================================
           7. PENGINGAT & PREDIKSI STOK RUMAH TANGGA & KATALOG DESKRIPSI BARANG
           ======================================================== */
        function renderReminders() {
            renderTurnoverPredictions();
            renderReminderModulePills();
            renderReminderCalendar();
            renderCustomRemindersList();
            renderItemCatalog();
            updateAllNotificationBadges();
        }

        function switchReminderSubMenu(menu) {
            state.reminderSubMenu = menu;
            const isSched = menu === 'reminders';
            const tabSched = document.getElementById('rtab-sub-reminders');
            const tabCat = document.getElementById('rtab-sub-catalog');
            const contSched = document.getElementById('remContentSchedule');
            const contCat = document.getElementById('remContentCatalog');

            const activeClass = "px-3.5 py-2 sm:py-1.5 rounded-xl text-xs font-bold transition-all bg-[var(--primary)] text-white border border-[var(--primary)] shadow-xs flex items-center justify-center gap-2 text-center";
            const inactiveClass = "px-3.5 py-2 sm:py-1.5 rounded-xl text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-main)] transition-all bg-transparent border border-transparent hover:bg-[var(--bg-main)]/50 flex items-center justify-center gap-2 text-center";

            if (tabSched) {
                tabSched.className = isSched ? activeClass : inactiveClass;
                tabSched.style.backgroundColor = isSched ? "var(--primary)" : "transparent";
            }

            if (tabCat) {
                tabCat.className = !isSched ? activeClass : inactiveClass;
                tabCat.style.backgroundColor = !isSched ? "var(--primary)" : "transparent";
            }

            if (contSched) contSched.classList.toggle('hidden', !isSched);
            if (contCat) contCat.classList.toggle('hidden', isSched);

            if (!isSched) {
                renderItemCatalog();
                renderTurnoverPredictions();
            }
        }

        function renderTurnoverPredictions() {
            const container = document.getElementById('smartTurnoverList');
            if (!container) return;

            // Hitung frekuensi pembelian per nama barang
            const itemCounts = {};
            state.entries.forEach(e => {
                const name = (e.itemName || '').trim();
                if (name.length > 2) {
                    if (!itemCounts[name]) itemCounts[name] = { name: name, count: 0, lastDate: e.date, cost: e.cost, cat: e.masterCategoryName };
                    itemCounts[name].count++;
                    if ((e.date || '') > (itemCounts[name].lastDate || '')) {
                        itemCounts[name].lastDate = e.date;
                    }
                }
            });

            const topItems = Object.values(itemCounts).filter(i => i.count >= 1).slice(0, 3);
            if (topItems.length === 0) {
                container.innerHTML = `<div class="col-span-full p-4 text-center text-xs text-[var(--text-muted)]">Belum cukup riwayat belanja untuk memprediksi perputaran stok.</div>`;
                return;
            }

            let html = '';
            topItems.forEach(it => {
                html += `
                    <div class="p-3.5 rounded-xl border border-[var(--border-color)] bg-[var(--bg-surface)] flex items-center justify-between gap-3">
                        <div class="min-w-0 flex-1">
                            <span class="text-xs font-bold text-[var(--text-main)] block truncate">${escapeHtml(it.name)}</span>
                            <span class="text-[10px] text-[var(--text-muted)]">Terakhir dibeli: ${it.lastDate || "-"}</span>
                        </div>
                        <button type="button" 
                                data-name="${escapeHtml(it.name)}" 
                                data-cost="${it.cost || 0}"
                                onclick="quickAddReminderFromTurnover(this.dataset.name, this.dataset.cost)" 
                                class="btn-secondary text-[11px] py-1 px-2.5 flex-shrink-0">
                            <i class="fa-solid fa-plus text-amber-500"></i> Buat Pengingat
                        </button>
                    </div>
                `;
            });
            container.innerHTML = html;
        }

        function quickAddReminderFromTurnover(itemName, cost) {
            openAddReminderModal();
            document.getElementById('remInputTitle').value = `Beli ulang ${itemName}`;
            document.getElementById('remInputEstCost').value = formatThousand(cost || '');
        }

        function setReminderTabFilter(tab) {
            state.reminderTab = tab;
            const rAct = document.getElementById('rtab-active');
            const rComp = document.getElementById('rtab-completed');
            if (tab === 'active') {
                if (rAct) { rAct.style.backgroundColor = "var(--primary)"; rAct.classList.add('text-white'); }
                if (rComp) { rComp.style.backgroundColor = "transparent"; rComp.classList.remove('text-white'); }
            } else {
                if (rComp) { rComp.style.backgroundColor = "var(--primary)"; rComp.classList.add('text-white'); }
                if (rAct) { rAct.style.backgroundColor = "transparent"; rAct.classList.remove('text-white'); }
            }
            renderCustomRemindersList();
        }

        /* ---------------- PENGATURAN PER-MODUL PENGINGAT ---------------- */
        function renderReminderModulePills() {
            const container = document.getElementById('reminderModulePillsContainer');
            const summaryEl = document.getElementById('reminderModuleSummary');
            const selectEl = document.getElementById('reminderModuleFilterSelect');

            const currentFilter = state.reminderModuleFilter || 'all';

            // Hitung statistik pengingat aktif per modul
            const activeReminders = (state.reminders || []).filter(r => !r.completed);
            const totalActiveCount = activeReminders.length;
            let totalActiveEstCost = 0;
            activeReminders.forEach(r => totalActiveEstCost += (Number(r.estCost) || 0));

            if (summaryEl) {
                summaryEl.innerHTML = `<span class="font-bold text-[var(--text-main)]">${totalActiveCount}</span> Pengingat Aktif &bull; Est: <b class="text-[var(--primary)] font-bold">${formatRupiah(totalActiveEstCost)}</b>`;
            }

            // Sinkronkan Dropdown Filter Modul
            if (selectEl) {
                let selHtml = `<option value="all">Semua Modul (${totalActiveCount})</option>`;
                state.masterCategories.forEach(cat => {
                    const count = activeReminders.filter(r => r.categoryId === cat.id).length;
                    selHtml += `<option value="${cat.id}">${escapeHtml(cat.name)} (${count})</option>`;
                });
                selectEl.innerHTML = selHtml;
                selectEl.value = currentFilter;
            }

            if (!container) return;

            let html = `
                <button type="button" onclick="setReminderModuleFilter('all')" 
                    class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${currentFilter === 'all' ? 'bg-[var(--primary)] text-white shadow-xs' : 'bg-[var(--bg-surface)] text-[var(--text-muted)] border border-[var(--border-color)] hover:border-[var(--primary)]'}">
                    <i class="fa-solid fa-layer-group text-[11px]"></i>
                    <span>Semua Modul</span>
                    <span class="text-[10px] px-1.5 py-0.2 rounded-full ${currentFilter === 'all' ? 'bg-white/20 text-white' : 'bg-[var(--border-color)]/60 text-[var(--text-muted)]'}">${totalActiveCount}</span>
                </button>
            `;

            state.masterCategories.forEach(cat => {
                const catReminders = activeReminders.filter(r => r.categoryId === cat.id);
                const isSelected = currentFilter === cat.id;
                html += `
                    <button type="button" onclick="setReminderModuleFilter('${cat.id}')" 
                        class="px-3 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 shrink-0 ${isSelected ? 'font-bold shadow-xs' : 'border border-[var(--border-color)] hover:border-[var(--primary)]'}"
                        style="${isSelected ? `background-color: ${cat.color}; color: white;` : `background-color: var(--bg-surface); color: var(--text-main);`}">
                        <i class="fa-solid ${cat.icon || 'fa-folder'} text-[11px]" style="${isSelected ? 'color: white;' : `color: ${cat.color};`}"></i>
                        <span>${escapeHtml(cat.name)}</span>
                        <span class="text-[10px] px-1.5 py-0.2 rounded-full" style="${isSelected ? 'background-color: rgba(255,255,255,0.25); color: white;' : 'background-color: var(--border-color); color: var(--text-muted);'}">${catReminders.length}</span>
                    </button>
                `;
            });

            container.innerHTML = html;
        }

        function setReminderModuleFilter(catId) {
            state.reminderModuleFilter = catId || 'all';
            const selectEl = document.getElementById('reminderModuleFilterSelect');
            if (selectEl) selectEl.value = state.reminderModuleFilter;
            renderReminderModulePills();
            renderReminderCalendar();
            renderCustomRemindersList();
        }

        /* ---------------- DATA & SYNC HARI LIBUR NASIONAL & CUTI BERSAMA (INDONESIA) ---------------- */
        const FALLBACK_INDONESIA_HOLIDAYS = {
            // 2025 SKB 3 Menteri (17 Hari Libur Nasional + 8 Hari Cuti Bersama)
            "2025": [
                { "date": "2025-01-01", "name": "Tahun Baru 2025 Masehi", "isCuti": false },
                { "date": "2025-01-27", "name": "Isra Mikraj Nabi Muhammad SAW", "isCuti": false },
                { "date": "2025-01-28", "name": "Cuti Bersama Tahun Baru Imlek 2576 Kongzili", "isCuti": true },
                { "date": "2025-01-29", "name": "Tahun Baru Imlek 2576 Kongzili", "isCuti": false },
                { "date": "2025-03-28", "name": "Cuti Bersama Hari Suci Nyepi (Saka 1947)", "isCuti": true },
                { "date": "2025-03-29", "name": "Hari Suci Nyepi (Tahun Baru Saka 1947)", "isCuti": false },
                { "date": "2025-03-31", "name": "Hari Raya Idulfitri 1446 H", "isCuti": false },
                { "date": "2025-04-01", "name": "Hari Raya Idulfitri 1446 H", "isCuti": false },
                { "date": "2025-04-02", "name": "Cuti Bersama Hari Raya Idulfitri 1446 H", "isCuti": true },
                { "date": "2025-04-03", "name": "Cuti Bersama Hari Raya Idulfitri 1446 H", "isCuti": true },
                { "date": "2025-04-04", "name": "Cuti Bersama Hari Raya Idulfitri 1446 H", "isCuti": true },
                { "date": "2025-04-07", "name": "Cuti Bersama Hari Raya Idulfitri 1446 H", "isCuti": true },
                { "date": "2025-04-18", "name": "Wafat Yesus Kristus (Jumat Agung)", "isCuti": false },
                { "date": "2025-04-20", "name": "Kebangkitan Yesus Kristus (Paskah)", "isCuti": false },
                { "date": "2025-05-01", "name": "Hari Buruh Internasional", "isCuti": false },
                { "date": "2025-05-12", "name": "Hari Raya Waisak 2569 BE", "isCuti": false },
                { "date": "2025-05-13", "name": "Cuti Bersama Hari Raya Waisak 2569 BE", "isCuti": true },
                { "date": "2025-05-29", "name": "Kenaikan Yesus Kristus", "isCuti": false },
                { "date": "2025-05-30", "name": "Cuti Bersama Kenaikan Yesus Kristus", "isCuti": true },
                { "date": "2025-06-01", "name": "Hari Lahir Pancasila", "isCuti": false },
                { "date": "2025-06-06", "name": "Hari Raya Iduladha 1446 H", "isCuti": false },
                { "date": "2025-06-09", "name": "Cuti Bersama Hari Raya Iduladha 1446 H", "isCuti": true },
                { "date": "2025-06-27", "name": "1 Muharam Tahun Baru Islam 1447 H", "isCuti": false },
                { "date": "2025-08-17", "name": "Proklamasi Kemerdekaan RI (HUT RI)", "isCuti": false },
                { "date": "2025-08-18", "name": "Cuti Bersama HUT Ke-80 Kemerdekaan RI", "isCuti": true },
                { "date": "2025-09-05", "name": "Maulid Nabi Muhammad SAW", "isCuti": false },
                { "date": "2025-12-25", "name": "Hari Raya Natal (Kelahiran Yesus Kristus)", "isCuti": false },
                { "date": "2025-12-26", "name": "Cuti Bersama Hari Raya Natal", "isCuti": true }
            ],
            // 2026 SKB 3 Menteri Resmi (17 Hari Libur Nasional + 8 Hari Cuti Bersama)
            "2026": [
                { "date": "2026-01-01", "name": "Tahun Baru 2026 Masehi", "isCuti": false },
                { "date": "2026-01-16", "name": "Isra Mikraj Nabi Muhammad SAW", "isCuti": false },
                { "date": "2026-02-16", "name": "Cuti Bersama Tahun Baru Imlek 2577 Kongzili", "isCuti": true },
                { "date": "2026-02-17", "name": "Tahun Baru Imlek 2577 Kongzili", "isCuti": false },
                { "date": "2026-03-18", "name": "Cuti Bersama Hari Suci Nyepi (Saka 1948)", "isCuti": true },
                { "date": "2026-03-19", "name": "Hari Suci Nyepi (Tahun Baru Saka 1948)", "isCuti": false },
                { "date": "2026-03-20", "name": "Cuti Bersama Hari Raya Idulfitri 1447 H", "isCuti": true },
                { "date": "2026-03-21", "name": "Hari Raya Idulfitri 1447 H", "isCuti": false },
                { "date": "2026-03-22", "name": "Hari Raya Idulfitri 1447 H", "isCuti": false },
                { "date": "2026-03-23", "name": "Cuti Bersama Hari Raya Idulfitri 1447 H", "isCuti": true },
                { "date": "2026-03-24", "name": "Cuti Bersama Hari Raya Idulfitri 1447 H", "isCuti": true },
                { "date": "2026-04-03", "name": "Wafat Yesus Kristus (Jumat Agung)", "isCuti": false },
                { "date": "2026-04-05", "name": "Kebangkitan Yesus Kristus (Paskah)", "isCuti": false },
                { "date": "2026-05-01", "name": "Hari Buruh Internasional", "isCuti": false },
                { "date": "2026-05-14", "name": "Kenaikan Yesus Kristus", "isCuti": false },
                { "date": "2026-05-15", "name": "Cuti Bersama Kenaikan Yesus Kristus", "isCuti": true },
                { "date": "2026-05-27", "name": "Hari Raya Iduladha 1447 H", "isCuti": false },
                { "date": "2026-05-28", "name": "Cuti Bersama Hari Raya Iduladha 1447 H", "isCuti": true },
                { "date": "2026-05-31", "name": "Hari Raya Waisak 2570 BE", "isCuti": false },
                { "date": "2026-06-01", "name": "Hari Lahir Pancasila", "isCuti": false },
                { "date": "2026-06-16", "name": "1 Muharam Tahun Baru Islam 1448 H", "isCuti": false },
                { "date": "2026-08-17", "name": "Hari Proklamasi Kemerdekaan RI", "isCuti": false },
                { "date": "2026-08-25", "name": "Maulid Nabi Muhammad SAW", "isCuti": false },
                { "date": "2026-12-24", "name": "Cuti Bersama Hari Raya Natal", "isCuti": true },
                { "date": "2026-12-25", "name": "Hari Raya Natal (Kelahiran Yesus Kristus)", "isCuti": false }
            ],
            // 2027 Proyeksi Standar
            "2027": [
                { "date": "2027-01-01", "name": "Tahun Baru 2027 Masehi", "isCuti": false },
                { "date": "2027-01-06", "name": "Isra Mikraj Nabi Muhammad SAW", "isCuti": false },
                { "date": "2027-02-06", "name": "Tahun Baru Imlek 2578 Kongzili", "isCuti": false },
                { "date": "2027-03-09", "name": "Hari Suci Nyepi (Saka 1949)", "isCuti": false },
                { "date": "2027-03-10", "name": "Hari Raya Idulfitri 1448 H", "isCuti": false },
                { "date": "2027-03-11", "name": "Hari Raya Idulfitri 1448 H", "isCuti": false },
                { "date": "2027-03-26", "name": "Wafat Yesus Kristus (Jumat Agung)", "isCuti": false },
                { "date": "2027-03-28", "name": "Kebangkitan Yesus Kristus (Paskah)", "isCuti": false },
                { "date": "2027-05-01", "name": "Hari Buruh Internasional", "isCuti": false },
                { "date": "2027-05-06", "name": "Kenaikan Yesus Kristus", "isCuti": false },
                { "date": "2027-05-17", "name": "Hari Raya Iduladha 1448 H", "isCuti": false },
                { "date": "2027-05-20", "name": "Hari Raya Waisak 2571 BE", "isCuti": false },
                { "date": "2027-06-01", "name": "Hari Lahir Pancasila", "isCuti": false },
                { "date": "2027-06-06", "name": "1 Muharam Tahun Baru Islam 1449 H", "isCuti": false },
                { "date": "2027-08-15", "name": "Maulid Nabi Muhammad SAW", "isCuti": false },
                { "date": "2027-08-17", "name": "Hari Proklamasi Kemerdekaan RI", "isCuti": false },
                { "date": "2027-12-25", "name": "Hari Raya Natal", "isCuti": false }
            ]
        };

        let holidayFetchInProgress = {};
        const HOLIDAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // Auto-update cek internet setiap 24 jam

        async function fetchIndonesianHolidays(year, forceRefresh = false) {
            const yearStr = String(year);
            state.holidaysCache = state.holidaysCache || {};

            let hasValidCache = false;

            // 1. Cek in-memory cache
            if (state.holidaysCache[yearStr] && Object.keys(state.holidaysCache[yearStr]).length > 0) {
                hasValidCache = true;
            }

            // 2. Cek local storage jika belum ada di memory
            if (!hasValidCache) {
                try {
                    const cached = safeStorage ? safeStorage.getItem('saturuma_holidays_' + yearStr) : null;
                    if (cached) {
                        const parsed = JSON.parse(cached);
                        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
                            state.holidaysCache[yearStr] = parsed;
                            hasValidCache = true;
                        }
                    }
                } catch (e) {
                    console.warn("Gagal membaca cache lokal hari libur:", e);
                }
            }

            // Pasang fallback dasar SKB 3 Menteri jika cache belum ada sama sekali
            if (!state.holidaysCache[yearStr] || Object.keys(state.holidaysCache[yearStr]).length === 0) {
                const fallbackList = FALLBACK_INDONESIA_HOLIDAYS[yearStr] || [];
                const fallbackMap = {};
                fallbackList.forEach(item => {
                    fallbackMap[item.date] = item;
                });
                state.holidaysCache[yearStr] = fallbackMap;
            }

            // Periksa apakah cache sudah kadaluarsa (> 24 jam) untuk otomatis perbarui dari internet
            const lastSync = safeStorage ? Number(safeStorage.getItem('saturuma_holidays_ts_' + yearStr) || 0) : 0;
            const isCacheExpired = (Date.now() - lastSync) > HOLIDAY_CACHE_TTL_MS;

            // Jika cache masih segar dan bukan forceRefresh, gunakan data cache langsung
            if (hasValidCache && !isCacheExpired && !forceRefresh) {
                return state.holidaysCache[yearStr];
            }

            // Hindari duplikasi background request untuk tahun yang sama
            if (holidayFetchInProgress[yearStr]) return state.holidaysCache[yearStr];
            holidayFetchInProgress[yearStr] = true;

            const statusEl = document.getElementById('holidaySourceStatus');
            if (statusEl) {
                statusEl.innerHTML = `<i class="fa-solid fa-arrows-rotate fa-spin text-amber-500"></i> Memperbarui libur internet...`;
            }

            try {
                let fetchedList = null;

                // Sumber 1: Nager.Date API (Layanan Terbuka Global, 100% Gratis, Tanpa Kuota / No Payment)
                try {
                    const controller1 = typeof AbortController !== 'undefined' ? new AbortController() : null;
                    const timeoutId1 = controller1 ? setTimeout(() => controller1.abort(), 6000) : null;
                    const res1 = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${yearStr}/ID`, {
                        method: 'GET',
                        headers: { 'Accept': 'application/json' },
                        signal: controller1 ? controller1.signal : undefined
                    });
                    if (timeoutId1) clearTimeout(timeoutId1);
                    if (res1.ok) {
                        const data1 = await res1.json();
                        if (Array.isArray(data1) && data1.length > 0) {
                            fetchedList = data1.map(item => {
                                const name = item.localName || item.name || '';
                                return {
                                    date: item.date,
                                    name: name,
                                    isCuti: name.toLowerCase().includes('cuti bersama')
                                };
                            });
                        }
                    }
                } catch (e1) {
                    console.warn("Nager.Date API gagal/timeout, beralih ke sumber CDN...", e1);
                }

                // Sumber 2: jsDelivr CDN / GitHub Raw (guangrei/APIHariLibur_V2 - Google Calendar Indonesia Sync, Gratis Permanen)
                if (!fetchedList) {
                    try {
                        const controller2 = typeof AbortController !== 'undefined' ? new AbortController() : null;
                        const timeoutId2 = controller2 ? setTimeout(() => controller2.abort(), 6000) : null;
                        const res2 = await fetch(`https://cdn.jsdelivr.net/gh/guangrei/APIHariLibur_V2@main/holidays.json`, {
                            method: 'GET',
                            headers: { 'Accept': 'application/json' },
                            signal: controller2 ? controller2.signal : undefined
                        });
                        if (timeoutId2) clearTimeout(timeoutId2);
                        if (res2.ok) {
                            const data2 = await res2.json();
                            if (data2 && typeof data2 === 'object') {
                                const list = [];
                                Object.keys(data2).forEach(d => {
                                    if (d.startsWith(yearStr + '-')) {
                                        const entry = data2[d];
                                        const name = Array.isArray(entry.summary) ? entry.summary.join(', ') : (entry.summary || entry.description || '');
                                        list.push({
                                            date: d,
                                            name: name,
                                            isCuti: name.toLowerCase().includes('cuti bersama')
                                        });
                                    }
                                });
                                if (list.length > 0) fetchedList = list;
                            }
                        }
                    } catch (e2) {
                        console.warn("jsDelivr CDN guangrei API gagal, beralih ke sumber komunitas...", e2);
                    }
                }

                // Sumber 3: API Hari Libur Komunitas Alternatif (api-hari-libur / dayoffapi)
                if (!fetchedList) {
                    try {
                        const controller3 = typeof AbortController !== 'undefined' ? new AbortController() : null;
                        const timeoutId3 = controller3 ? setTimeout(() => controller3.abort(), 6000) : null;
                        const res3 = await fetch(`https://api-hari-libur.vercel.app/api?year=${yearStr}`, {
                            method: 'GET',
                            headers: { 'Accept': 'application/json' },
                            signal: controller3 ? controller3.signal : undefined
                        });
                        if (timeoutId3) clearTimeout(timeoutId3);
                        if (res3.ok) {
                            const data3 = await res3.json();
                            const rawList3 = Array.isArray(data3) ? data3 : (data3.data || []);
                            if (rawList3.length > 0) {
                                fetchedList = rawList3.map(item => {
                                    const desc = item.description || item.keterangan || item.holiday_name || item.name || '';
                                    return {
                                        date: item.date || item.tanggal || item.holiday_date,
                                        name: desc,
                                        isCuti: desc.toLowerCase().includes('cuti bersama') || !!item.is_cuti
                                    };
                                });
                            }
                        }
                    } catch (e3) {
                        console.warn("API hari libur komunitas gagal...", e3);
                    }
                }

                if (fetchedList && fetchedList.length > 0) {
                    const holidaysMap = {};
                    
                    // Pertahankan data Cuti Bersama resmi SKB jika API luar hanya memberikan Libur Nasional
                    const fallbackList = FALLBACK_INDONESIA_HOLIDAYS[yearStr] || [];
                    fallbackList.forEach(item => {
                        if (item.isCuti) holidaysMap[item.date] = item;
                    });

                    fetchedList.forEach(item => {
                        if (item.date) holidaysMap[item.date] = item;
                    });

                    state.holidaysCache[yearStr] = holidaysMap;
                    if (safeStorage) {
                        try {
                            safeStorage.setItem('saturuma_holidays_' + yearStr, JSON.stringify(holidaysMap));
                            safeStorage.setItem('saturuma_holidays_ts_' + yearStr, String(Date.now()));
                        } catch (e) {}
                    }

                    if (statusEl) {
                        statusEl.innerHTML = `<i class="fa-solid fa-cloud-arrow-down text-emerald-500"></i> Libur Otomatis Terupdate`;
                    }
                    renderReminderCalendar();
                    return holidaysMap;
                }
            } catch (err) {
                console.warn("Koneksi internet libur nasional gagal, menggunakan data kalender lokal:", err);
            } finally {
                holidayFetchInProgress[yearStr] = false;
            }

            if (statusEl) {
                statusEl.innerHTML = `<i class="fa-solid fa-circle-check text-blue-500"></i> Libur Nasional SKB`;
            }
            return state.holidaysCache[yearStr];
        }

        // Listener saat browser terhubung kembali ke internet, perbarui kalender secara otomatis
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => {
                if (state.reminderCalendarDate) {
                    fetchIndonesianHolidays(state.reminderCalendarDate.getFullYear(), true);
                }
            });
        }

        function refreshIndonesianHolidays(force = true) {
            if (!state.reminderCalendarDate) state.reminderCalendarDate = new Date();
            const year = state.reminderCalendarDate.getFullYear();
            showToast("Memperbarui data hari libur & cuti bersama...");
            fetchIndonesianHolidays(year, force).then(() => {
                showToast("Data hari libur nasional & cuti bersama siap!", "success");
            }).catch(err => {
                console.warn("Refresh hari libur gagal:", err);
                showToast("Menggunakan data SKB 3 Menteri lokal", "info");
            });
        }

        function getHolidayInfo(dateStr, year) {
            const yearStr = String(year || (dateStr ? dateStr.split('-')[0] : ''));
            if (!state.holidaysCache) state.holidaysCache = {};
            if (!state.holidaysCache[yearStr]) {
                fetchIndonesianHolidays(yearStr);
            }
            return (state.holidaysCache[yearStr] && state.holidaysCache[yearStr][dateStr]) || null;
        }

        /* ---------------- WIDGET KALENDER VISUAL PENGINGAT ---------------- */
        function renderReminderCalendar() {
            const grid = document.getElementById('reminderCalendarGrid');
            const monthLabel = document.getElementById('reminderCalendarMonthLabel');
            if (!grid) return;

            if (!state.reminderCalendarDate) {
                state.reminderCalendarDate = new Date();
            }

            const year = state.reminderCalendarDate.getFullYear();
            const month = state.reminderCalendarDate.getMonth();

            // Pastikan data libur & cuti bersama sedang/sudah dimuat untuk tahun kalender aktif
            fetchIndonesianHolidays(year);

            const monthNames = [
                "Januari", "Februari", "Maret", "April", "Mei", "Juni",
                "Juli", "Agustus", "September", "Oktober", "November", "Desember"
            ];

            if (monthLabel) {
                monthLabel.innerText = `${monthNames[month]} ${year}`;
            }

            const today = new Date();
            const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

            // Hari pertama adalah SENIN:
            // getDay(): 0 = Minggu, 1 = Senin, ..., 6 = Sabtu
            // Indeks kalender dengan Senin = 0, Selasa = 1, ..., Sabtu = 5, Minggu = 6
            const firstDayRaw = new Date(year, month, 1).getDay();
            const firstDayIndex = (firstDayRaw + 6) % 7;

            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const prevMonthDays = new Date(year, month, 0).getDate();

            const activeModuleFilter = state.reminderModuleFilter || 'all';
            const reminderMap = {};

            (state.reminders || []).forEach(r => {
                if (!r.dueDate) return;
                if (activeModuleFilter !== 'all' && r.categoryId !== activeModuleFilter) return;

                if (!reminderMap[r.dueDate]) reminderMap[r.dueDate] = [];
                reminderMap[r.dueDate].push(r);
            });

            let html = '';
            const holidaysInMonth = [];

            // Tanggal bulan sebelumnya (dimmed)
            for (let i = firstDayIndex - 1; i >= 0; i--) {
                const d = prevMonthDays - i;
                const prevDate = new Date(year, month - 1, d);
                const prevDow = prevDate.getDay();
                const isPrevWeekend = (prevDow === 0 || prevDow === 6);
                html += `
                    <div class="h-16 sm:h-20 p-1 rounded-lg border border-dashed border-[var(--border-color)]/40 bg-[var(--bg-main)]/30 opacity-30 text-[10px] flex flex-col justify-between cursor-default">
                        <span class="font-semibold ${isPrevWeekend ? 'text-rose-500 font-bold' : ''}">${d}</span>
                    </div>
                `;
            }

            // Tanggal bulan ini
            for (let day = 1; day <= daysInMonth; day++) {
                const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const dateObj = new Date(year, month, day);
                const dayOfWeek = dateObj.getDay(); // 0 = Minggu, 6 = Sabtu
                const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6); // Hari Sabtu dan Minggu adalah tanggal merah

                // Libur Nasional dan Cuti Bersama
                const holiday = getHolidayInfo(dateStr, year);
                const isHoliday = !!holiday;
                const isCuti = isHoliday && !!holiday.isCuti;
                const isNationalHoliday = isHoliday && !holiday.isCuti;

                if (isHoliday) {
                    holidaysInMonth.push({
                        day: day,
                        dateStr: dateStr,
                        name: holiday.name,
                        isCuti: isCuti,
                        dayOfWeek: dayOfWeek
                    });
                }

                // Tanggal merah jika: Sabtu, Minggu, Libur Nasional, atau Cuti Bersama
                const isRedDate = isWeekend || isNationalHoliday || isCuti;

                const isToday = dateStr === todayStr;
                const isSelected = state.reminderSelectedDate === dateStr;
                const dayReminders = reminderMap[dateStr] || [];
                const hasReminders = dayReminders.length > 0;

                // Styling bingkai & latar belakang sel kalender
                let borderClass = '';
                if (isSelected) {
                    borderClass = 'border-2 border-[var(--primary)] ring-2 ring-[var(--primary)]/30 bg-[var(--primary-light)]/20 shadow-xs';
                } else if (isToday) {
                    borderClass = 'border-2 border-amber-500/80 bg-amber-500/5 shadow-2xs';
                } else if (isNationalHoliday || isCuti) {
                    borderClass = 'border border-rose-500/40 bg-rose-500/[0.04] hover:border-rose-500/80 shadow-2xs';
                } else if (isWeekend) {
                    borderClass = 'border border-rose-500/25 bg-rose-500/[0.02] hover:border-rose-400/60';
                } else {
                    borderClass = 'border border-[var(--border-color)] bg-[var(--bg-surface)] hover:border-[var(--primary)]/60';
                }

                // Pewarnaan nomor tanggal (merah untuk tanggal merah, libur nasional, cuti bersama, sabtu, minggu)
                let numberColorClass = '';
                if (isToday) {
                    numberColorClass = 'text-amber-500 font-black';
                } else if (isSelected) {
                    numberColorClass = 'text-[var(--primary)] font-black';
                } else if (isRedDate) {
                    numberColorClass = 'text-rose-500 font-black';
                } else {
                    numberColorClass = 'text-[var(--text-main)] font-semibold';
                }

                // Tag sudut kanan atas sel (hanya hari ini, keterangan libur dihilangkan dari dalam kotak tanggal)
                let tagHtml = '';
                if (isToday) {
                    tagHtml = '<span class="text-[8px] font-black uppercase tracking-tighter px-1 py-0.2 rounded bg-amber-500 text-white leading-none">Hari ini</span>';
                }

                html += `
                    <div onclick="selectReminderCalendarDate('${dateStr}')" 
                        class="h-16 sm:h-20 p-1.5 rounded-xl ${borderClass} transition-all cursor-pointer flex flex-col justify-between group relative overflow-hidden"
                        title="${isHoliday ? escapeHtml(holiday.name) + ' (' + (isCuti ? 'Cuti Bersama' : 'Libur Nasional') + ') - ' : ''}${isWeekend ? (dayOfWeek === 6 ? 'Sabtu' : 'Minggu') + ' (Tanggal Merah)' : dateStr}">
                        <div class="flex items-center justify-between">
                            <span class="text-[11px] ${numberColorClass}">
                                ${day}
                            </span>
                            ${tagHtml}
                        </div>

                        <!-- Indikator Badge Pengingat Belanja -->
                        <div class="space-y-0.5 overflow-hidden">
                            ${hasReminders ? `
                                <div class="flex items-center gap-1 flex-wrap">
                                    ${dayReminders.slice(0, 2).map(r => {
                                        const cat = state.masterCategories.find(c => c.id === r.categoryId) || { color: '#10B981', name: 'Umum' };
                                        return `
                                            <span class="text-[8px] font-bold px-1 py-0.2 rounded truncate max-w-full block leading-tight ${r.completed ? 'line-through opacity-60' : ''}" 
                                                style="background-color: ${hexToRgba(cat.color, 0.18)}; color: ${cat.color};"
                                                title="${escapeHtml(r.title)} (${formatRupiah(r.estCost)})">
                                                ${escapeHtml(r.title)}
                                            </span>
                                        `;
                                    }).join('')}
                                    ${dayReminders.length > 2 ? `<span class="text-[8px] font-black text-[var(--primary)]">+${dayReminders.length - 2}</span>` : ''}
                                </div>
                            ` : `
                                <div class="opacity-0 group-hover:opacity-100 transition-opacity text-[9px] text-[var(--text-muted)] text-right">
                                    <i class="fa-solid fa-plus text-[8px] text-[var(--primary)]"></i>
                                </div>
                            `}
                        </div>
                    </div>
                `;
            }

            // Hari penutup bulan berikutnya agar genap kelipatan 7
            const totalRendered = firstDayIndex + daysInMonth;
            const remainingDays = (7 - (totalRendered % 7)) % 7;
            for (let day = 1; day <= remainingDays; day++) {
                const nextDate = new Date(year, month + 1, day);
                const nextDow = nextDate.getDay();
                const isNextWeekend = (nextDow === 0 || nextDow === 6);
                html += `
                    <div class="h-16 sm:h-20 p-1 rounded-lg border border-dashed border-[var(--border-color)]/40 bg-[var(--bg-main)]/30 opacity-30 text-[10px] flex flex-col justify-between cursor-default">
                        <span class="font-semibold ${isNextWeekend ? 'text-rose-500 font-bold' : ''}">${day}</span>
                    </div>
                `;
            }

            grid.innerHTML = html;

            // Render Daftar Keterangan Hari Libur Nasional & Cuti Bersama di Bawah Kalender
            const holidaysListContainer = document.getElementById('reminderCalendarHolidaysList');
            const holidaysBadge = document.getElementById('reminderCalendarHolidaysCountBadge');
            const holidaysMonthSub = document.getElementById('reminderCalendarHolidaysMonthSub');

            if (holidaysMonthSub) {
                holidaysMonthSub.innerText = `${monthNames[month]} ${year}`;
            }

            if (holidaysBadge) {
                holidaysBadge.innerText = `${holidaysInMonth.length} Hari Libur`;
            }

            if (holidaysListContainer) {
                const dayNamesId = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
                if (holidaysInMonth.length === 0) {
                    holidaysListContainer.innerHTML = `
                        <div class="col-span-full py-3 px-3.5 rounded-xl bg-[var(--bg-surface)] border border-dashed border-[var(--border-color)] text-[11px] text-[var(--text-muted)] flex items-center gap-2">
                            <i class="fa-solid fa-circle-info text-[var(--primary)] text-xs"></i>
                            <span>Tidak ada hari libur nasional atau cuti bersama pada bulan <b>${monthNames[month]} ${year}</b>.</span>
                        </div>
                    `;
                } else {
                    let hHtml = '';
                    holidaysInMonth.forEach(h => {
                        const dayName = dayNamesId[h.dayOfWeek];
                        const isSelectedHoliday = state.reminderSelectedDate === h.dateStr;
                        hHtml += `
                            <div onclick="selectReminderCalendarDate('${h.dateStr}')" 
                                class="p-2.5 rounded-xl border ${isSelectedHoliday ? 'border-2 border-[var(--primary)] ring-2 ring-[var(--primary)]/20 bg-[var(--primary-light)]/20' : (h.isCuti ? 'border-amber-500/30 bg-amber-500/[0.04] hover:border-amber-500/70' : 'border-rose-500/30 bg-rose-500/[0.04] hover:border-rose-500/70')} flex items-center gap-2.5 transition-all cursor-pointer group hover:scale-[1.01]"
                                title="Klik untuk melihat/menyorot tanggal ${h.day} ${monthNames[month]} ${year} di kalender">
                                <div class="w-10 h-10 rounded-lg flex-shrink-0 flex flex-col items-center justify-center font-black ${h.isCuti ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'}">
                                    <span class="text-xs leading-none">${h.day}</span>
                                    <span class="text-[7.5px] uppercase tracking-wider font-semibold opacity-80 leading-none mt-0.5">${monthNames[month].substring(0, 3)}</span>
                                </div>
                                <div class="min-w-0 flex-1">
                                    <div class="flex items-center gap-1.5 flex-wrap mb-0.5">
                                        <span class="text-[10px] font-semibold text-[var(--text-muted)]">${dayName}, ${h.day} ${monthNames[month]} ${year}</span>
                                        <span class="text-[8px] font-bold px-1.5 py-0.2 rounded-full ${h.isCuti ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300' : 'bg-rose-500/20 text-rose-700 dark:text-rose-300'}">
                                            ${h.isCuti ? 'Cuti Bersama' : 'Libur Nasional'}
                                        </span>
                                    </div>
                                    <p class="text-xs font-bold text-[var(--text-main)] leading-snug group-hover:text-rose-600 dark:group-hover:text-rose-400 transition-colors">
                                        ${escapeHtml(h.name)}
                                    </p>
                                </div>
                            </div>
                        `;
                    });
                    holidaysListContainer.innerHTML = hHtml;
                }
            }

            // Update banner filter tanggal jika ada
            const banner = document.getElementById('reminderCalendarActiveFilterBanner');
            const bannerText = document.getElementById('reminderCalendarSelectedDateText');
            if (state.reminderSelectedDate) {
                if (banner) banner.classList.remove('hidden');
                let displayInfo = state.reminderSelectedDate;
                const hol = getHolidayInfo(state.reminderSelectedDate, year);
                if (hol) {
                    displayInfo += ` (${hol.isCuti ? '🏖️ Cuti Bersama: ' : '🔴 Libur Nasional: '}${hol.name})`;
                } else {
                    const selDateObj = new Date(state.reminderSelectedDate + 'T00:00:00');
                    const selDow = selDateObj.getDay();
                    if (selDow === 0) displayInfo += ' (Hari Minggu - Tanggal Merah)';
                    else if (selDow === 6) displayInfo += ' (Hari Sabtu - Tanggal Merah)';
                }
                if (bannerText) bannerText.innerText = displayInfo;
            } else {
                if (banner) banner.classList.add('hidden');
            }
        }

        function changeReminderCalendarMonth(delta) {
            if (!state.reminderCalendarDate) state.reminderCalendarDate = new Date();
            state.reminderCalendarDate.setMonth(state.reminderCalendarDate.getMonth() + delta);
            const year = state.reminderCalendarDate.getFullYear();
            fetchIndonesianHolidays(year);
            renderReminderCalendar();
        }

        function goToReminderCalendarToday() {
            state.reminderCalendarDate = new Date();
            state.reminderSelectedDate = null;
            const year = state.reminderCalendarDate.getFullYear();
            fetchIndonesianHolidays(year);
            renderReminderCalendar();
            renderCustomRemindersList();
        }

        function selectReminderCalendarDate(dateStr) {
            if (state.reminderSelectedDate === dateStr) {
                state.reminderSelectedDate = null;
            } else {
                state.reminderSelectedDate = dateStr;
            }
            renderReminderCalendar();
            renderCustomRemindersList();
        }

        function clearReminderCalendarDateFilter() {
            state.reminderSelectedDate = null;
            renderReminderCalendar();
            renderCustomRemindersList();
        }

        function goToInputWithCalendarDate() {
            activateManualAction();
            if (state.reminderSelectedDate) {
                const formDate = document.getElementById('formDate');
                if (formDate) {
                    formDate.value = state.reminderSelectedDate;
                }
            }
        }

        function addReminderWithCalendarDate() {
            if (state.reminderSelectedDate) {
                openAddReminderModalWithDate(state.reminderSelectedDate);
            } else {
                openAddReminderModal();
            }
        }

        /* ---------------- DAFTAR PENGINGAT & KONVERSI KE INPUT ---------------- */
        function renderCustomRemindersList() {
            const container = document.getElementById('customRemindersList');
            if (!container) return;

            const isDoneFilter = state.reminderTab === 'completed';
            const activeModuleFilter = state.reminderModuleFilter || 'all';
            const selectedDate = state.reminderSelectedDate;

            let list = (state.reminders || []).filter(r => !!r.completed === isDoneFilter);

            // Filter modul kategori
            if (activeModuleFilter !== 'all') {
                list = list.filter(r => r.categoryId === activeModuleFilter);
            }

            // Filter tanggal kalender jika dipilih
            if (selectedDate) {
                list = list.filter(r => r.dueDate === selectedDate);
            }

            if (list.length === 0) {
                container.innerHTML = `
                    <div class="p-6 text-center rounded-xl border border-dashed border-[var(--border-color)] bg-[var(--bg-surface)] text-xs text-[var(--text-muted)] space-y-2">
                        <i class="fa-solid fa-calendar-check text-2xl opacity-40 block mb-1"></i>
                        <span>Tidak ada pengingat pada filter ini ${selectedDate ? `untuk tanggal <b>${selectedDate}</b>` : ''}.</span>
                        <div class="pt-1 flex items-center justify-center gap-2 flex-wrap">
                            ${selectedDate ? `<button type="button" onclick="clearReminderCalendarDateFilter()" class="btn-secondary text-[11px] py-1 px-2.5">Tampilkan Semua Tanggal</button>` : ''}
                            <button type="button" onclick="openAddReminderModalWithDate('${selectedDate || ''}')" class="btn-primary text-[11px] py-1 px-3">
                                <i class="fa-solid fa-plus text-[10px]"></i> Tambah Pengingat Baru
                            </button>
                        </div>
                    </div>
                `;
                return;
            }

            let html = '';
            list.forEach(r => {
                const catObj = state.masterCategories.find(c => c.id === r.categoryId) || { name: 'Umum', color: '#10B981', icon: 'fa-bell', sheetName: 'DB_Umum' };
                html += `
                    <div class="category-card p-3.5 bg-[var(--bg-surface)] flex flex-col sm:flex-row sm:items-center justify-between gap-3" style="${getCategoryCardStyle(catObj.color, { borderLeftWidth: '4.5px' })}">
                        <div class="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                            <input type="checkbox" ${r.completed ? 'checked' : ''} onchange="toggleReminderStatus('${r.id}')" class="w-4 h-4 rounded text-[var(--primary)] cursor-pointer mt-0.5 sm:mt-0 shrink-0" title="${r.completed ? 'Tandai Belum Selesai' : 'Tandai Selesai'}">
                            
                            ${r.photoUrl ? `
                                <button type="button" 
                                        data-title="${escapeHtml(r.title)}" 
                                        data-photo="${escapeHtml(r.photoUrl)}"
                                        onclick="openPhotoPreviewModal(this.dataset.title, this.dataset.photo)" 
                                        class="w-11 h-11 rounded-lg overflow-hidden border border-[var(--border-color)] shrink-0 relative group" 
                                        title="Lihat Foto Barang">
                                    <img src="${r.photoUrl}" alt="Foto" class="w-full h-full object-cover">
                                    <span class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-[10px] transition-opacity">
                                        <i class="fa-solid fa-magnifying-glass-plus"></i>
                                    </span>
                                </button>
                            ` : ''}

                            <div class="min-w-0 flex-1 space-y-1">
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="text-xs font-bold text-[var(--text-main)] ${r.completed ? 'line-through text-[var(--text-muted)]' : ''} truncate">${escapeHtml(r.title)}</span>
                                    <!-- Badge Modul Kategori -->
                                    <span class="text-[9px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 shrink-0" 
                                        style="background-color: ${hexToRgba(catObj.color, 0.12)}; color: ${catObj.color}; border-color: ${hexToRgba(catObj.color, 0.25)};">
                                        <i class="fa-solid ${catObj.icon || 'fa-folder'} text-[9px]"></i>
                                        <span>${escapeHtml(catObj.name)}</span>
                                    </span>
                                </div>
                                ${r.description ? `<p class="text-[11px] text-[var(--text-muted)] truncate max-w-md">${escapeHtml(r.description)}</p>` : ''}
                                <div class="flex items-center gap-3 text-[10px] text-[var(--text-muted)] flex-wrap">
                                    <span class="flex items-center gap-1">
                                        <i class="fa-regular fa-calendar text-[var(--primary)]"></i> Jatuh tempo: <b>${r.dueDate || "-"}</b>
                                    </span>
                                    <span class="flex items-center gap-1">
                                        <i class="fa-solid fa-money-bill-wave text-emerald-600"></i> Est. Biaya: <b class="text-[var(--text-main)]">${formatRupiah(r.estCost)}</b>
                                    </span>
                                </div>
                            </div>
                        </div>

                        <!-- Grup Tombol Aksi: Jadikan Input & Hapus -->
                        <div class="flex items-center gap-2 self-end sm:self-auto shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-[var(--border-color)] w-full sm:w-auto justify-end">
                            <!-- Tombol Merubah Catatan Pengingat Menjadi Input Transaksi -->
                            <button type="button" onclick="convertReminderToInput('${r.id}')" 
                                class="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 font-bold shadow-2xs hover:scale-102 transition-transform" 
                                title="Salin rincian pengingat ini langsung ke formulir Input Transaksi">
                                <i class="fa-solid fa-cart-plus text-[11px]"></i>
                                <span>Jadikan Input</span>
                            </button>

                            <!-- Tombol Hapus -->
                            <button type="button" onclick="deleteReminder('${r.id}')" 
                                class="text-xs text-rose-500 hover:text-rose-700 p-2 rounded-lg hover:bg-rose-500/10 transition-colors" 
                                title="Hapus Pengingat">
                                <i class="fa-solid fa-trash-can"></i>
                            </button>
                        </div>
                    </div>
                `;
            });
            container.innerHTML = html;
        }

        /* ---------------- FUNGSI MERUBAH PENGINGAT MENJADI INPUT TRANSAKSI ---------------- */
        function convertReminderToInput(id) {
            const rem = (state.reminders || []).find(r => r.id === id);
            if (!rem) return;

            // Beralih ke view input transaksi
            setAppMode('input');

            // Reset formulir transaksi ke kondisi awal
            resetTransactionForm();

            // Pasang Modul Kategori sesuai pengingat
            const catSel = document.getElementById('formMasterCategorySelect');
            if (catSel && rem.categoryId) {
                catSel.value = rem.categoryId;
                updateItemSubCategoryOptions();
            }

            // Pasang Toko / Merchant jika ada, atau gunakan judul pengingat
            const merchantInp = document.getElementById('formMerchant');
            if (merchantInp) {
                merchantInp.value = rem.title || "Toko Kebutuhan";
            }

            // Set Tanggal transaksi ke hari ini
            const dateInp = document.getElementById('formDate');
            if (dateInp) {
                dateInp.value = new Date().toISOString().split('T')[0];
            }

            // Bersihkan item default dan masukkan rincian dari pengingat
            const container = document.getElementById('formItemsContainer');
            if (container) {
                container.innerHTML = '';
                state.formItemIndexCounter = 0;
                addNewItemRow({
                    itemName: rem.title,
                    qty: 1,
                    cost: rem.estCost || 0,
                    photoUrl: rem.photoUrl || ''
                });
            }

            // Scroll ke formulir input
            const formSection = document.getElementById('view-input');
            if (formSection) {
                try {
                    formSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } catch(e) {}
            }

            showToast(`Catatan pengingat "${rem.title}" berhasil dialihkan ke formulir input transaksi!`, "success");
        }

        function openAddReminderModal(presetCategory = null, presetDate = null) {
            const modal = document.getElementById('addReminderModal');
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
            // Pastikan dropdown kategori selalu mutakhir
            updateCategoryDropdowns();

            const dateInput = document.getElementById('remInputDueDate');
            if (dateInput) {
                if (presetDate) {
                    dateInput.value = formatToStrictDateString(presetDate);
                } else if (!dateInput.value) {
                    const nextWeek = new Date();
                    nextWeek.setDate(nextWeek.getDate() + 7);
                    dateInput.value = formatToStrictDateString(nextWeek);
                }
            }
            const catSelect = document.getElementById('remInputCategory');
            if (catSelect) {
                const targetCat = presetCategory || (state.reminderModuleFilter && state.reminderModuleFilter !== 'all' ? state.reminderModuleFilter : (state.masterCategories[0]?.id || ''));
                if (targetCat) catSelect.value = targetCat;
                if (typeof updateCustomDropdownSelectedLabel === 'function') {
                    updateCustomDropdownSelectedLabel(catSelect);
                }
            }
        }

        function openAddReminderModalWithDate(dateStr) {
            openAddReminderModal(state.reminderModuleFilter !== 'all' ? state.reminderModuleFilter : null, dateStr);
        }

        function closeAddReminderModal() {
            const modal = document.getElementById('addReminderModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
            // Reset photo & inputs
            removeReminderPhoto();
            const form = document.getElementById('reminderForm');
            if (form) form.reset();
            const catSelect = document.getElementById('remInputCategory');
            if (catSelect && typeof updateCustomDropdownSelectedLabel === 'function') {
                updateCustomDropdownSelectedLabel(catSelect);
            }
        }

        function handleReminderPhotoUpload(e) {
            const file = e.target.files && e.target.files[0];
            if (!file) return;

            compressImageFile(file, 900, 0.8, function(dataUrl) {
                if (!dataUrl) {
                    showToast("Format gambar tidak didukung atau rusak.", "error");
                    return;
                }
                const hiddenInput = document.getElementById('remInputPhotoBase64');
                const uploadPlaceholder = document.getElementById('remPhotoUploadPlaceholder');
                const attachedBox = document.getElementById('remPhotoAttachedBox');
                const prevThumb = document.getElementById('remPhotoPreviewThumb');
                const prevContainer = document.getElementById('remPhotoPreviewContainer');
                const prevImg = document.getElementById('remPhotoPreviewImg');

                if (hiddenInput) hiddenInput.value = dataUrl;
                if (prevThumb) prevThumb.src = dataUrl;
                if (prevImg) prevImg.src = dataUrl;
                if (uploadPlaceholder) uploadPlaceholder.classList.add('hidden');
                if (attachedBox) {
                    attachedBox.classList.remove('hidden');
                    attachedBox.classList.add('flex');
                }
                if (prevContainer) {
                    prevContainer.classList.remove('hidden');
                    prevContainer.classList.add('flex');
                }
            });
        }

        function removeReminderPhoto() {
            const fileInput = document.getElementById('remInputPhotoFile');
            const hiddenInput = document.getElementById('remInputPhotoBase64');
            const uploadPlaceholder = document.getElementById('remPhotoUploadPlaceholder');
            const attachedBox = document.getElementById('remPhotoAttachedBox');
            const prevThumb = document.getElementById('remPhotoPreviewThumb');
            const prevContainer = document.getElementById('remPhotoPreviewContainer');
            const prevImg = document.getElementById('remPhotoPreviewImg');

            if (fileInput) fileInput.value = '';
            if (hiddenInput) hiddenInput.value = '';
            if (prevThumb) prevThumb.src = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E';
            if (prevImg) prevImg.src = '';
            if (attachedBox) {
                attachedBox.classList.remove('flex');
                attachedBox.classList.add('hidden');
            }
            if (uploadPlaceholder) {
                uploadPlaceholder.classList.remove('hidden');
            }
            if (prevContainer) {
                prevContainer.classList.remove('flex');
                prevContainer.classList.add('hidden');
            }
        }

        function previewCurrentReminderPhoto() {
            const hiddenInput = document.getElementById('remInputPhotoBase64');
            const titleInput = document.getElementById('remInputTitle');
            const photoUrl = hiddenInput ? hiddenInput.value : '';
            const title = titleInput && titleInput.value ? titleInput.value : 'Foto Barang Pengingat';
            if (photoUrl && typeof openPhotoPreviewModal === 'function') {
                openPhotoPreviewModal(title, photoUrl);
            }
        }

        function handleSaveReminder(e) {
            e.preventDefault();
            const title = document.getElementById('remInputTitle').value.trim();
            const categoryId = document.getElementById('remInputCategory').value;
            const dueDate = document.getElementById('remInputDueDate').value;
            const estCost = parseThousand(document.getElementById('remInputEstCost').value);
            const notes = document.getElementById('remInputNotes')?.value.trim() || '';
            const photoBase64 = document.getElementById('remInputPhotoBase64')?.value || '';

            const newRem = {
                id: "REM-" + Date.now(),
                title: title,
                categoryId: categoryId,
                dueDate: dueDate,
                estCost: estCost,
                description: notes,
                photoUrl: photoBase64,
                completed: false
            };

            state.reminders = state.reminders || [];
            state.reminders.push(newRem);
            safeStorage.setItem('saturuma_reminders', JSON.stringify(state.reminders));
            closeAddReminderModal();
            renderReminders();
            showToast("Pengingat berhasil disimpan!");
        }

        function toggleReminderStatus(id) {
            state.reminders = (state.reminders || []).map(r => {
                if (r.id === id) r.completed = !r.completed;
                return r;
            });
            safeStorage.setItem('saturuma_reminders', JSON.stringify(state.reminders));
            renderReminders();
        }

        function deleteReminder(id) {
            state.reminders = (state.reminders || []).filter(r => r.id !== id);
            safeStorage.setItem('saturuma_reminders', JSON.stringify(state.reminders));
            renderReminders();
            showToast("Pengingat dihapus.");
        }

        /* ---------------- SUB-MENU: KATALOG & DESKRIPSI BARANG ---------------- */
        function renderItemCatalog() {
            const grid = document.getElementById('itemCatalogGrid');
            const emptyState = document.getElementById('itemCatalogEmptyState');
            if (!grid) return;

            const searchQ = (state.itemCatalogSearch || '').toLowerCase().trim();
            const catFilter = state.itemCatalogCategoryFilter || 'all';

            const allItems = state.stockItems || [];
            const filtered = allItems.filter(it => {
                const matchCat = catFilter === 'all' || it.categoryId === catFilter;
                const matchSearch = !searchQ || 
                    (it.name || '').toLowerCase().includes(searchQ) ||
                    (it.description || '').toLowerCase().includes(searchQ) ||
                    (it.location || '').toLowerCase().includes(searchQ);
                return matchCat && matchSearch;
            });

            if (filtered.length === 0) {
                grid.innerHTML = '';
                if (emptyState) emptyState.classList.remove('hidden');
                return;
            }

            if (emptyState) emptyState.classList.add('hidden');

            let html = '';
            filtered.forEach(it => {
                const catObj = state.masterCategories.find(c => c.id === it.categoryId) || { name: 'Dapur', color: '#10B981', icon: 'fa-box' };
                html += `
                    <div class="glass-card overflow-hidden flex flex-col justify-between border transition-all duration-200 group shadow-xs hover:shadow-md" style="border-color: ${hexToRgba(catObj.color, 0.45)}; border-top: 4px solid ${catObj.color};">
                        <!-- Header Foto & Badge Kategori -->
                        <div class="relative w-full h-40 bg-[var(--bg-main)] overflow-hidden flex items-center justify-center">
                            ${it.photoUrl ? `
                                <img src="${it.photoUrl}" alt="${escapeHtml(it.name)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300">
                                <button type="button" 
                                        data-name="${escapeHtml(it.name)}" 
                                        data-photo="${escapeHtml(it.photoUrl)}"
                                        onclick="openPhotoPreviewModal(this.dataset.name, this.dataset.photo)" 
                                        class="absolute top-2 right-2 w-8 h-8 rounded-lg bg-black/60 text-white flex items-center justify-center text-xs hover:bg-black transition-colors shadow-sm" 
                                        title="Perbesar Foto">
                                    <i class="fa-solid fa-magnifying-glass-plus"></i>
                                </button>
                            ` : `
                                <div class="flex flex-col items-center justify-center gap-1.5 text-[var(--text-muted)]">
                                    <div class="w-12 h-12 rounded-xl flex items-center justify-center text-lg" style="background-color: ${hexToRgba(catObj.color, 0.15)}; color: ${catObj.color};">
                                        <i class="fa-solid ${catObj.icon || 'fa-box'}"></i>
                                    </div>
                                    <button type="button" onclick="openItemCatalogModal('${it.id}')" class="text-[10px] font-bold text-[var(--primary)] hover:underline flex items-center gap-1">
                                        <i class="fa-solid fa-camera"></i>+ Tambah Foto
                                    </button>
                                </div>
                            `}
                            <span class="absolute top-2 left-2 text-[10px] font-bold px-2 py-0.5 rounded-full text-white shadow-xs" style="background-color: ${catObj.color};">
                                ${escapeHtml(catObj.name)}
                            </span>
                        </div>

                        <!-- Konten Informasi Barang -->
                        <div class="p-3.5 flex-1 flex flex-col justify-between space-y-3">
                            <div class="space-y-1.5">
                                <h4 class="text-xs font-bold text-[var(--text-main)] leading-snug line-clamp-2">${escapeHtml(it.name)}</h4>
                                <p class="text-[11px] text-[var(--text-muted)] leading-relaxed line-clamp-2" title="${escapeHtml(it.description || '')}">
                                    ${escapeHtml(it.description || "Belum ada catatan deskripsi spesifikasi barang.")}
                                </p>
                            </div>

                            <!-- Meta Info (Lokasi, Satuan, Harga) -->
                            <div class="pt-2 border-t border-[var(--border-color)]/60 grid grid-cols-2 gap-2 text-[11px]">
                                <div>
                                    <span class="text-[10px] text-[var(--text-muted)] block">Lokasi Simpan:</span>
                                    <span class="font-bold text-[var(--text-main)] truncate block flex items-center gap-1">
                                        <i class="fa-solid fa-location-dot text-[var(--primary)] text-[10px]"></i>
                                        ${escapeHtml(it.location || "Dapur / Lemari")}
                                    </span>
                                </div>
                                <div>
                                    <span class="text-[10px] text-[var(--text-muted)] block">Referensi Harga:</span>
                                    <span class="font-bold text-[var(--text-main)] truncate block">
                                        ${it.estCost ? formatRupiah(it.estCost) : '-'}${it.unit ? ` <span class="text-[10px] font-normal text-[var(--text-muted)]">/ ${escapeHtml(it.unit)}</span>` : ''}
                                    </span>
                                </div>
                            </div>

                            <!-- Tombol Aksi -->
                            <div class="pt-2 border-t border-[var(--border-color)] flex items-center justify-between gap-1.5">
                                <button type="button" onclick="createReminderFromStockItem('${it.id}')" class="btn-primary text-[11px] py-1.5 px-2.5 flex-1 flex items-center justify-center gap-1.5 shadow-xs" title="Jadwalkan Pengingat Belanja untuk Barang Ini">
                                    <i class="fa-solid fa-bell text-xs"></i>
                                    <span>Jadikan Pengingat</span>
                                </button>
                                <div class="flex items-center gap-1">
                                    <button type="button" onclick="openItemPriceHistoryModal('${escapeHtml(it.name)}')" class="w-8 h-8 rounded-lg border border-[var(--border-color)] hover:border-blue-500 text-[var(--text-muted)] hover:text-blue-500 flex items-center justify-center text-xs transition-colors" title="Lihat Riwayat Harga & Pantauan Inflasi">
                                        <i class="fa-solid fa-chart-line"></i>
                                    </button>
                                    <button type="button" onclick="openItemCatalogModal('${it.id}')" class="w-8 h-8 rounded-lg border border-[var(--border-color)] hover:border-[var(--primary)] text-[var(--text-muted)] hover:text-[var(--text-main)] flex items-center justify-center text-xs transition-colors" title="Edit Deskripsi & Foto">
                                        <i class="fa-solid fa-pen"></i>
                                    </button>
                                    <button type="button" onclick="deleteStockItem('${it.id}')" class="w-8 h-8 rounded-lg border border-[var(--border-color)] hover:border-rose-500 text-[var(--text-muted)] hover:text-rose-500 flex items-center justify-center text-xs transition-colors" title="Hapus Barang">
                                        <i class="fa-solid fa-trash-can"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            });

            grid.innerHTML = html;
        }

        function handleItemCatalogSearch(val) {
            state.itemCatalogSearch = val || '';
            renderItemCatalog();
        }

        function handleItemCatalogCategoryFilter(val) {
            state.itemCatalogCategoryFilter = val || 'all';
            renderItemCatalog();
        }

        function resetItemCatalogFilters() {
            state.itemCatalogCategoryFilter = 'all';
            state.itemCatalogSearch = '';
            const searchInp = document.getElementById('itemCatalogSearchInput');
            if (searchInp) searchInp.value = '';
            const catSelect = document.getElementById('itemCatalogCategoryFilter');
            if (catSelect) catSelect.value = 'all';
            renderItemCatalog();
            showToast("Filter katalog barang berhasil direset ke default.", "info", 1500);
        }

        function openItemCatalogModal(editId) {
            const modal = document.getElementById('itemCatalogModal');
            const headerTitle = document.getElementById('itemModalHeaderTitle');
            const editInput = document.getElementById('itemCatalogEditId');
            const nameInput = document.getElementById('itemInputName');
            const catSelect = document.getElementById('itemInputCategory');
            const locInput = document.getElementById('itemInputLocation');
            const descInput = document.getElementById('itemInputDesc');
            const costInput = document.getElementById('itemInputEstCost');
            const unitInput = document.getElementById('itemInputUnit');

            if (!modal) return;

            // Pastikan dropdown kategori terisi
            updateCategoryDropdowns();

            if (editId) {
                const item = (state.stockItems || []).find(i => i.id === editId);
                if (item) {
                    if (headerTitle) headerTitle.innerText = "Edit Deskripsi Barang";
                    const submitText = document.getElementById('btnSubmitItemCatalogText');
                    if (submitText) submitText.innerText = "Perbarui Barang";
                    if (editInput) editInput.value = item.id;
                    if (nameInput) nameInput.value = item.name || '';
                    if (catSelect) catSelect.value = item.categoryId || state.masterCategories[0]?.id || '';
                    if (locInput) locInput.value = item.location || '';
                    if (descInput) descInput.value = item.description || '';
                    if (costInput) costInput.value = formatThousand(item.estCost || '');
                    if (unitInput) unitInput.value = item.unit || '';

                    if (item.photoUrl) {
                        const prevImg = document.getElementById('itemPhotoPreviewImg');
                        const prevCont = document.getElementById('itemPhotoPreviewContainer');
                        const placeholder = document.getElementById('itemPhotoPlaceholder');
                        const base64Input = document.getElementById('itemPhotoBase64');
                        if (prevImg) prevImg.src = item.photoUrl;
                        if (base64Input) base64Input.value = item.photoUrl;
                        if (prevCont) { prevCont.classList.remove('hidden'); prevCont.classList.add('flex'); }
                        if (placeholder) placeholder.classList.add('hidden');
                    } else {
                        removeItemPhoto();
                    }
                }
            } else {
                if (headerTitle) headerTitle.innerText = "Tambah Deskripsi Barang";
                const submitText = document.getElementById('btnSubmitItemCatalogText');
                if (submitText) submitText.innerText = "Simpan Barang Baru";
                if (editInput) editInput.value = '';
                document.getElementById('itemCatalogForm')?.reset();
                removeItemPhoto();
            }

            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeItemCatalogModal() {
            const modal = document.getElementById('itemCatalogModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
            removeItemPhoto();
        }

        function handleItemPhotoUpload(e) {
            const file = e.target.files && e.target.files[0];
            if (!file) return;

            compressImageFile(file, 900, 0.8, function(dataUrl) {
                if (!dataUrl) {
                    showToast("Gagal memuat gambar atau format tidak didukung.", "error");
                    return;
                }
                const base64Input = document.getElementById('itemPhotoBase64');
                const prevImg = document.getElementById('itemPhotoPreviewImg');
                const prevCont = document.getElementById('itemPhotoPreviewContainer');
                const placeholder = document.getElementById('itemPhotoPlaceholder');

                if (base64Input) base64Input.value = dataUrl;
                if (prevImg) prevImg.src = dataUrl;
                if (prevCont) { prevCont.classList.remove('hidden'); prevCont.classList.add('flex'); }
                if (placeholder) placeholder.classList.add('hidden');
            });
        }

        function removeItemPhoto() {
            const fileInput = document.getElementById('itemPhotoFileInput');
            const base64Input = document.getElementById('itemPhotoBase64');
            const prevImg = document.getElementById('itemPhotoPreviewImg');
            const prevCont = document.getElementById('itemPhotoPreviewContainer');
            const placeholder = document.getElementById('itemPhotoPlaceholder');

            if (fileInput) fileInput.value = '';
            if (base64Input) base64Input.value = '';
            if (prevImg) prevImg.src = '';
            if (prevCont) { prevCont.classList.remove('flex'); prevCont.classList.add('hidden'); }
            if (placeholder) placeholder.classList.remove('hidden');
        }

        function handleSaveItemCatalog(e) {
            e.preventDefault();
            const editId = document.getElementById('itemCatalogEditId')?.value;
            const name = document.getElementById('itemInputName')?.value.trim();
            const categoryId = document.getElementById('itemInputCategory')?.value;
            const location = document.getElementById('itemInputLocation')?.value.trim();
            const description = document.getElementById('itemInputDesc')?.value.trim();
            const estCost = parseThousand(document.getElementById('itemInputEstCost')?.value);
            const unit = document.getElementById('itemInputUnit')?.value.trim();
            const photoUrl = document.getElementById('itemPhotoBase64')?.value || '';

            if (!name) {
                showToast("Nama barang harus diisi!", "error");
                return;
            }

            state.stockItems = state.stockItems || [];

            if (editId) {
                state.stockItems = state.stockItems.map(it => {
                    if (it.id === editId) {
                        return { ...it, name, categoryId, location, description, estCost, unit, photoUrl };
                    }
                    return it;
                });
                showToast("Deskripsi barang berhasil diperbarui!");
            } else {
                const newItem = {
                    id: "STK-" + Date.now(),
                    name: name,
                    categoryId: categoryId,
                    location: location,
                    description: description,
                    estCost: estCost,
                    unit: unit,
                    photoUrl: photoUrl,
                    createdAt: new Date().toISOString()
                };
                state.stockItems.unshift(newItem);
                showToast("Barang baru berhasil ditambahkan ke katalog!");
            }

            safeStorage.setItem('saturuma_stock_items', JSON.stringify(state.stockItems));
            closeItemCatalogModal();
            renderItemCatalog();
        }

        async function deleteStockItem(id) {
            const confirmed = await customConfirm("Hapus barang ini dari katalog deskripsi?", {
                title: "Hapus Barang Katalog",
                type: "danger",
                confirmText: "Ya, Hapus"
            });
            if (!confirmed) return;
            state.stockItems = (state.stockItems || []).filter(i => i.id !== id);
            safeStorage.setItem('saturuma_stock_items', JSON.stringify(state.stockItems));
            renderItemCatalog();
            showToast("Barang dihapus dari katalog.");
        }

        function createReminderFromStockItem(id) {
            const item = (state.stockItems || []).find(i => i.id === id);
            if (!item) return;

            // Beralih ke sub-menu jadwal pengingat
            switchReminderSubMenu('reminders');
            openAddReminderModal();

            const titleInput = document.getElementById('remInputTitle');
            const catSelect = document.getElementById('remInputCategory');
            const notesInput = document.getElementById('remInputNotes');
            const costInput = document.getElementById('remInputEstCost');
            const photoHidden = document.getElementById('remInputPhotoBase64');
            const prevImg = document.getElementById('remPhotoPreviewImg');
            const prevCont = document.getElementById('remPhotoPreviewContainer');

            if (titleInput) titleInput.value = `Beli ulang ${item.name}`;
            if (catSelect) {
                catSelect.value = item.categoryId;
                if (typeof updateCustomDropdownSelectedLabel === 'function') {
                    updateCustomDropdownSelectedLabel(catSelect);
                }
            }
            if (notesInput) notesInput.value = item.description || (item.location ? `Lokasi: ${item.location}` : '');
            if (costInput) costInput.value = formatThousand(item.estCost || '');

            if (item.photoUrl) {
                if (photoHidden) photoHidden.value = item.photoUrl;
                if (prevImg) prevImg.src = item.photoUrl;
                const prevThumb = document.getElementById('remPhotoPreviewThumb');
                if (prevThumb) prevThumb.src = item.photoUrl;
                const uploadPlaceholder = document.getElementById('remPhotoUploadPlaceholder');
                const attachedBox = document.getElementById('remPhotoAttachedBox');
                if (uploadPlaceholder) uploadPlaceholder.classList.add('hidden');
                if (attachedBox) {
                    attachedBox.classList.remove('hidden');
                    attachedBox.classList.add('flex');
                }
                if (prevCont) { prevCont.classList.remove('hidden'); prevCont.classList.add('flex'); }
            }

            showToast(`Data "${item.name}" otomatis dipasang ke form pengingat.`);
        }

        function compressImageFile(file, maxWidth = 900, quality = 0.8, callback) {
            if (!file || !file.type.startsWith('image/')) {
                if (callback) callback(null);
                return;
            }
            const reader = new FileReader();
            reader.onload = function(e) {
                const img = new Image();
                img.onload = function() {
                    let w = img.width;
                    let h = img.height;
                    if (w > maxWidth) {
                        h = Math.round((h * maxWidth) / w);
                        w = maxWidth;
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    const dataUrl = canvas.toDataURL('image/jpeg', quality);
                    if (callback) callback(dataUrl);
                };
                img.onerror = function() {
                    if (callback) callback(e.target.result);
                };
                img.src = e.target.result;
            };
            reader.onerror = function() {
                if (callback) callback(null);
            };
            reader.readAsDataURL(file);
        }

        /* ========================================================
           8. PENGATURAN / SETTINGS & MASTER KATEGORI CRUD
           ======================================================== */
        function getMultiModuleConfig() {
            if (!state.multiModuleConfig) {
                try {
                    const saved = safeStorage.getItem('saturuma_multi_module_config');
                    if (saved) state.multiModuleConfig = JSON.parse(saved);
                } catch(e) {}
            }
            if (!state.multiModuleConfig) {
                state.multiModuleConfig = {
                    id: 'all',
                    name: 'Semua Modul (Multi-Modul)',
                    sheetName: 'DB_Multi (Virtual)',
                    color: '#10B981',
                    icon: 'fa-layer-group'
                };
            }
            return state.multiModuleConfig;
        }

        function renderSettingsCategories() {
            const grid = document.getElementById('settingsCategoryGrid');
            if (!grid) return;

            const catBadge = document.getElementById('settingsCatCountBadge');
            if (catBadge) catBadge.innerText = `${state.masterCategories.length + 1} Modul (Termasuk Multi-Modul)`;

            const multiConfig = getMultiModuleConfig();

            let html = `
                <!-- KARTU KHUSUS: SEMUA MODUL (MULTI-MODUL) -->
                <div class="category-card p-4 bg-[var(--bg-surface)] space-y-3 col-span-full" style="${getCategoryCardStyle(multiConfig.color, { borderLeftWidth: '5px' })}">
                    <div class="flex items-center justify-between pb-2 border-b border-[var(--border-color)]">
                        <div class="flex items-center gap-2.5">
                            <span class="w-9 h-9 rounded-xl flex items-center justify-center text-base font-bold shadow-xs" style="background-color: ${hexToRgba(multiConfig.color, 0.15)}; color: ${multiConfig.color};">
                                <i class="fa-solid ${multiConfig.icon || 'fa-layer-group'}"></i>
                            </span>
                            <div>
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    <h4 class="text-xs sm:text-sm font-bold text-[var(--text-main)]">${escapeHtml(multiConfig.name)}</h4>
                                    <span class="text-[9px] font-extrabold px-2 py-0.5 rounded-full" style="background-color: ${hexToRgba(multiConfig.color, 0.15)}; color: ${multiConfig.color};">Multi-Modul & Overview</span>
                                </div>
                                <span class="text-[10px] text-[var(--text-muted)] font-mono">Routing Virtual / Lintas-Modul</span>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="text-[11px] font-mono font-bold px-2 py-0.5 rounded border border-[var(--border-color)]" style="color: ${multiConfig.color}; background-color: ${hexToRgba(multiConfig.color, 0.08)};">${multiConfig.color}</span>
                            <span class="w-4 h-4 rounded-full border border-black/10 shadow-2xs" style="background-color: ${multiConfig.color};" title="${multiConfig.color}"></span>
                        </div>
                    </div>

                    <div class="text-[11px] text-[var(--text-muted)] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <span>Konfigurasi warna tema aksen utama dan ikon visual untuk tinjauan gabungan seluruh modul.</span>
                        <button type="button" onclick="editMasterCategory('all')" class="btn-primary text-xs py-1.5 px-3 self-start sm:self-auto shadow-xs">
                            <i class="fa-solid fa-palette"></i> Pilih Warna & Ikon
                        </button>
                    </div>
                </div>
            `;

            state.masterCategories.forEach(cat => {
                const subCount = cat.subCategories ? cat.subCategories.length : 0;
                html += `
                    <div class="category-card p-4 bg-[var(--bg-surface)] space-y-3" style="${getCategoryCardStyle(cat.color, { borderLeftWidth: '5px' })}">
                        <div class="flex items-center justify-between pb-2 border-b border-[var(--border-color)]">
                            <div class="flex items-center gap-2.5">
                                <span class="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shadow-2xs" style="background-color: ${hexToRgba(cat.color, 0.15)}; color: ${cat.color};">
                                    <i class="fa-solid ${cat.icon || 'fa-folder'}"></i>
                                </span>
                                <div>
                                    <h4 class="text-xs font-bold text-[var(--text-main)]">${escapeHtml(cat.name)}</h4>
                                    <span class="text-[10px] text-[var(--text-muted)] font-mono">${cat.sheetName}</span>
                                </div>
                            </div>
                            <div class="flex items-center gap-1.5">
                                <span class="text-[10px] font-mono font-bold" style="color: ${cat.color};">${cat.color}</span>
                                <span class="w-4 h-4 rounded-full border border-black/10 shadow-2xs" style="background-color: ${cat.color};"></span>
                            </div>
                        </div>

                        <div class="text-[11px] text-[var(--text-muted)]">
                            <span class="font-bold text-[var(--text-main)]">${subCount}</span> Sub Kategori:
                            <div class="flex flex-wrap gap-1 mt-1">
                                ${(cat.subCategories || []).slice(0, 3).map(s => `
                                    <span class="px-1.5 py-0.5 rounded text-[9px] bg-[var(--border-color)]/50 text-[var(--text-muted)]">${escapeHtml(s)}</span>
                                `).join('')}
                                ${subCount > 3 ? `<span class="text-[9px] text-[var(--text-muted)]">+${subCount - 3} lainnya</span>` : ''}
                            </div>
                        </div>

                        <div class="pt-2 border-t border-[var(--border-color)] flex items-center justify-end gap-2">
                            <button type="button" onclick="editMasterCategory('${cat.id}')" class="btn-secondary text-[11px] py-1 px-2.5 hover:border-[var(--primary)]">
                                <i class="fa-solid fa-palette text-xs" style="color: ${cat.color};"></i> Pilih Warna & Ikon
                            </button>
                            <button type="button" onclick="deleteMasterCategory('${cat.id}')" class="btn-secondary text-[11px] py-1 px-2.5 text-rose-500 hover:text-rose-700">
                                <i class="fa-solid fa-trash"></i> Hapus
                            </button>
                        </div>
                    </div>
                `;
            });

            grid.innerHTML = html;

            // Load saved settings to form inputs
            const apiKeyInp = document.getElementById('settingsGeminiApiKey');
            if (apiKeyInp) apiKeyInp.value = safeStorage.getItem('saturuma_gemini_key') || '';

            const modelSel = document.getElementById('settingsAiModelSelect');
            if (modelSel) modelSel.value = normalizeGeminiModelName(safeStorage.getItem('saturuma_ai_model'));

            const budgetInp = document.getElementById('settingsMonthlyBudgetInput');
            if (budgetInp) budgetInp.value = formatThousand(state.stats.monthlyBudget || 10000000);

            renderBackendSettings();
        }

        function renderBackendSettings() {
            const urlInp = document.getElementById('settingsGasApiUrl');
            const pill = document.getElementById('gasStatusPill');
            const metaBox = document.getElementById('gasMetadataInfoBox');
            const sheetLink = document.getElementById('metaSheetLink');
            const driveLink = document.getElementById('metaDriveLink');

            const currentUrl = getActiveGasApiUrl();
            if (urlInp) urlInp.value = currentUrl;

            if (currentUrl) {
                if (pill) {
                    pill.className = "text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400";
                    pill.innerHTML = `<i class="fa-solid fa-circle-check text-xs mr-1"></i> Terhubung (Apps Script)`;
                }
                if (metaBox) {
                    metaBox.classList.remove('hidden');
                    if (sheetLink && state.metadata && state.metadata.spreadsheetUrl) sheetLink.href = state.metadata.spreadsheetUrl;
                    if (driveLink && state.metadata && state.metadata.receiptsFolderUrl) driveLink.href = state.metadata.receiptsFolderUrl;
                }
            } else {
                if (pill) {
                    pill.className = "text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400";
                    pill.innerHTML = `<i class="fa-solid fa-hard-drive text-xs mr-1"></i> Mode Standalone (Lokal)`;
                }
                if (metaBox) metaBox.classList.add('hidden');
            }
        }

        async function testAndSaveGasUrl() {
            const inp = document.getElementById('settingsGasApiUrl');
            const rawUrl = inp ? inp.value.trim() : "";
            if (!rawUrl) {
                showToast("Masukkan URL Google Apps Script Web App terlebih dahulu.");
                return;
            }

            const pill = document.getElementById('gasStatusPill');
            if (pill) {
                pill.className = "text-xs font-semibold px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-[var(--text-muted)]";
                pill.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin text-xs mr-1"></i> Menguji koneksi & keamanan...`;
            }

            try {
                showToast("Menguji koneksi ke Google Apps Script...");
                const check = await verifyAndPingBackendUrl(rawUrl);

                if (inp) inp.value = check.url;
                safeStorage.setItem('saturuma_gas_api_url', check.url);
                if (window.APP_CONFIG) window.APP_CONFIG.GAS_API_URL = check.url;

                showToast("Berhasil terhubung ke Google Apps Script!");
                renderBackendSettings();
                loadEntriesFromBackend();
            } catch (err) {
                console.error("Test GAS connection error:", err);
                if (pill) {
                    pill.className = "text-xs font-semibold px-2.5 py-1 rounded-full bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400";
                    pill.innerHTML = `<i class="fa-solid fa-circle-xmark text-xs mr-1"></i> Gagal Terhubung`;
                }
                showToast("Gagal: " + err.message);
            }
        }

        function disconnectGasUrl() {
            safeStorage.removeItem('saturuma_gas_api_url');
            if (window.APP_CONFIG) window.APP_CONFIG.GAS_API_URL = "";
            const urlInp = document.getElementById('settingsGasApiUrl');
            if (urlInp) urlInp.value = "";
            renderBackendSettings();
            showToast("Koneksi backend diputuskan. Beralih ke penyimpanan lokal.");
        }

        async function syncSpreadsheetStructureFromUI() {
            const btn = document.getElementById('btnSyncSheetStructure');
            const originalHtml = btn ? btn.innerHTML : '';
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin text-xs"></i> <span>Menyinkronkan Kolom...</span>`;
            }

            try {
                showToast("Menyinkronkan struktur tabel database Google Sheets...", "info");
                if (typeof google !== 'undefined' && google.script && google.script.run) {
                    google.script.run
                        .withSuccessHandler(function(resp) {
                            if (btn) {
                                btn.disabled = false;
                                btn.innerHTML = originalHtml;
                            }
                            if (resp && resp.success) {
                                showToast(resp.message || "Struktur tabel sheet berhasil disinkronkan ke 14 kolom!", "success");
                            } else {
                                showToast((resp && resp.message) || "Gagal menyinkronkan sheet.", "error");
                            }
                        })
                        .withFailureHandler(function(err) {
                            if (btn) {
                                btn.disabled = false;
                                btn.innerHTML = originalHtml;
                            }
                            showToast("Gagal: " + err.message, "error");
                        })
                        .syncSheetStructure((state.currentUser && state.currentUser.customSpreadsheetId) || "");
                } else {
                    const apiUrl = getActiveGasApiUrl();
                    if (!apiUrl) {
                        showToast("Koneksi cloud Google Sheets belum disetel. Seluruh tabel saat ini aktif pada format 14 kolom di aplikasi.", "info");
                        if (btn) {
                            btn.disabled = false;
                            btn.innerHTML = originalHtml;
                        }
                        return;
                    }

                    runGAS('syncSheetStructure', [(state.currentUser && state.currentUser.customSpreadsheetId) || ""], (json) => {
                        if (btn) {
                            btn.disabled = false;
                            btn.innerHTML = originalHtml;
                        }
                        if (json && json.success) {
                            showToast(json.message || "Struktur sheet berhasil disinkronkan ke 14 kolom (termasuk kolom 'Other')!", "success");
                        } else {
                            showToast((json && json.message) || "Gagal menyinkronkan sheet", "error");
                        }
                    }, (err) => {
                        if (btn) {
                            btn.disabled = false;
                            btn.innerHTML = originalHtml;
                        }
                        showToast("Gagal menyinkronkan sheet: " + err.message, "error");
                    });
                }
            } catch(e) {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalHtml;
                }
                showToast("Gagal: " + e.message, "error");
            }
        }

        const CATEGORY_COLOR_PRESETS = [
            { name: "Emerald", hex: "#10B981" },
            { name: "Teal", hex: "#14B8A6" },
            { name: "Cyan", hex: "#06B6D4" },
            { name: "Sky Blue", hex: "#0EA5E9" },
            { name: "Blue", hex: "#3B82F6" },
            { name: "Indigo", hex: "#6366F1" },
            { name: "Violet", hex: "#8B5CF6" },
            { name: "Purple", hex: "#A855F7" },
            { name: "Fuchsia", hex: "#D946EF" },
            { name: "Pink", hex: "#EC4899" },
            { name: "Rose", hex: "#F43F5E" },
            { name: "Red", hex: "#EF4444" },
            { name: "Orange", hex: "#F97316" },
            { name: "Amber", hex: "#F59E0B" },
            { name: "Yellow", hex: "#EAB308" },
            { name: "Lime", hex: "#84CC16" },
            { name: "Green", hex: "#22C55E" },
            { name: "Slate", hex: "#64748B" }
        ];

        const CATEGORY_ICON_LIST = [
            // Belanja & Kebutuhan
            { icon: "fa-basket-shopping", label: "Keranjang Belanja", tags: "belanja mart supermarket pasar grocery" },
            { icon: "fa-cart-shopping", label: "Troli Belanja", tags: "troli cart supermarket toko" },
            { icon: "fa-bag-shopping", label: "Kantong Belanja", tags: "mall tas belanja shopping bag" },
            { icon: "fa-store", label: "Toko / Warung", tags: "warung kios minimarket store shop" },
            { icon: "fa-receipt", label: "Struk Belanja", tags: "struk nota bon kwitansi receipt" },
            { icon: "fa-tags", label: "Diskon & Promo", tags: "promo sale diskon label tag" },

            // Dapur, Makanan & Minuman
            { icon: "fa-utensils", label: "Makan & Resto", tags: "kuliner resto cafe makan restoran dapur food" },
            { icon: "fa-bowl-food", label: "Bahan Pokok & Makanan", tags: "beras sembako sayur lauk pauk food" },
            { icon: "fa-kitchen-set", label: "Dapur & Memasak", tags: "dapur panci wajan kompor alat masak" },
            { icon: "fa-wheat-awn", label: "Beras & Gandum", tags: "beras sembako panen tani karbo" },
            { icon: "fa-apple-whole", label: "Buah & Sayur", tags: "buah sayuran segar pasar vitamin" },
            { icon: "fa-carrot", label: "Sayuran", tags: "sayur wortel pasar sehat vegetarian" },
            { icon: "fa-fish", label: "Ikan & Seafood", tags: "ikan laut lele nila seafood protein" },
            { icon: "fa-drumstick-bite", label: "Daging & Ayam", tags: "ayam sapi daging sosis unggas" },
            { icon: "fa-egg", label: "Telur & Susu", tags: "telur dairy susu margarin keju" },
            { icon: "fa-bread-slice", label: "Roti & Sarapan", tags: "roti kue bakery sarapan pagi" },
            { icon: "fa-burger", label: "Fast Food & Burger", tags: "burger camilan jajan fastfood" },
            { icon: "fa-pizza-slice", label: "Pizza & Snack", tags: "pizza kuliner jajan nongkrong" },
            { icon: "fa-mug-hot", label: "Kopi & Minuman", tags: "kopi teh cafe nongkrong minuman" },
            { icon: "fa-bottle-water", label: "Air Galon & Mineral", tags: "galon air mineral aqua isi ulang" },
            { icon: "fa-cookie-bite", label: "Kue & Biskuit", tags: "biskuit snack keripik jajan camilan" },

            // Rumah Tangga & Perawatan
            { icon: "fa-house", label: "Rumah & Tempat Tinggal", tags: "rumah kontrakan kos residence home" },
            { icon: "fa-couch", label: "Perabot / Furniture", tags: "sofa kursi mebel furniture ruang tamu" },
            { icon: "fa-bed", label: "Kamar & Kasur", tags: "kasur sprei selimut bantal kamar tidur" },
            { icon: "fa-bath", label: "Kamar Mandi", tags: "toilet wastafel mandi bathroom" },
            { icon: "fa-broom", label: "Kebersihan & Sapu", tags: "sapu pel bersih-bersih alat kebersihan" },
            { icon: "fa-soap", label: "Sabun & Pembersih", tags: "sabun deterjen sunlight cuci piring" },
            { icon: "fa-jug-detergent", label: "Deterjen & Cuci Baju", tags: "deterjen laundry cuci pakaian softener" },
            { icon: "fa-toilet-paper", label: "Tissue & Sanitasi", tags: "tisu tissue sanitasi basah kering" },
            { icon: "fa-spray-can-sparkles", label: "Pengharum / Obat Hama", tags: "bayfresh baygon semprotan wangi" },
            { icon: "fa-screwdriver-wrench", label: "Perbaikan & Alat", tags: "obeng perkakas bengkel perbaikan tukang" },
            { icon: "fa-hammer", label: "Tukang & Bangunan", tags: "renovasi semen cat palu material bahan" },
            { icon: "fa-seedling", label: "Tanaman & Kebun", tags: "taman kebun tanaman bunga pupuk pot" },

            // Bayi, Anak & Pakaian
            { icon: "fa-baby-carriage", label: "Perlengkapan Bayi", tags: "stroller bayi baby perlengkapan anak" },
            { icon: "fa-baby", label: "Kebutuhan Bayi & Popok", tags: "bayi popok susu pampers formula anak" },
            { icon: "fa-person-breastfeeding", label: "Ibu & Menyusui", tags: "asi menyusui mom baby ibu" },
            { icon: "fa-children", label: "Anak & Keluarga", tags: "anak balita mainan bermain playground" },
            { icon: "fa-shirt", label: "Pakaian & Sandang", tags: "baju kemeja kaos celana pakaian fashion" },
            { icon: "fa-vest", label: "Busana & Seragam", tags: "seragam jaket rompi busana baju" },
            { icon: "fa-socks", label: "Sepatu & Kaos Kaki", tags: "sepatu sandal kaos kaki alas kaki" },
            { icon: "fa-shapes", label: "Mainan Edukatif", tags: "mainan lego edukasi puzzle balita" },

            // Tagihan, Utilitas & Langganan
            { icon: "fa-file-invoice-dollar", label: "Tagihan Bulanan", tags: "tagihan bayar iuran invoice bill" },
            { icon: "fa-bolt", label: "Listrik & PLN", tags: "token pln listrik daya pulsa listrik" },
            { icon: "fa-faucet-drip", label: "Air & PDAM", tags: "pdam air ledeng meteran pam" },
            { icon: "fa-fire-flame-curved", label: "Gas & Elpiji", tags: "gas elpiji lpg pgn tabung gas kompor" },
            { icon: "fa-wifi", label: "Internet & WiFi", tags: "indihome biznet firstmedia internet wifi kuota" },
            { icon: "fa-tower-cell", label: "Pulsa & Paket Data", tags: "pulsa paket data telkomsel xl indosat kuota" },
            { icon: "fa-tv", label: "Streaming & TV", tags: "netflix spotify youtube disney tv kabel streaming" },
            { icon: "fa-shield-halved", label: "Iuran Lingkungan / RT", tags: "rt rw iuran sampah keamanan lingkungan satpam" },

            // Tabungan, Finansial & Investasi
            { icon: "fa-piggy-bank", label: "Tabungan Celengan", tags: "menabung tabungan celengan simpanan" },
            { icon: "fa-wallet", label: "Dompet & E-Wallet", tags: "dompet gopay ovo dana shopeepay uang cash" },
            { icon: "fa-money-bill-wave", label: "Uang Tunai & Gaji", tags: "cash tunai gaji pemasukan income bonus" },
            { icon: "fa-coins", label: "Koin / Uang Receh", tags: "uang receh koin tips parkir" },
            { icon: "fa-vault", label: "Dana Darurat / Brankas", tags: "brankas dana darurat aman deposito" },
            { icon: "fa-chart-line", label: "Investasi & Saham", tags: "saham reksadana crypto investasi obligasi" },
            { icon: "fa-hand-holding-dollar", label: "Sedekah, Zakat & Infaq", tags: "sedekah zakat donasi infaq amal sosial" },
            { icon: "fa-credit-card", label: "Kartu Kredit & Cicilan", tags: "kredit cicilan paylater kartu angsuran" },

            // Transportasi & Perjalanan
            { icon: "fa-car", label: "Mobil Keluarga", tags: "mobil service cuci mobil bengkel oli" },
            { icon: "fa-gas-pump", label: "Bensin & BBM", tags: "spbu pertalite pertamax bensin bbm solar" },
            { icon: "fa-motorcycle", label: "Motor & Ojek", tags: "sepeda motor gojek grab ojol bensin motor" },
            { icon: "fa-bus", label: "Transportasi Umum", tags: "busway transjakarta tj angkot krl tj bus" },
            { icon: "fa-train", label: "Kereta & KRL / MRT", tags: "kereta api mrt lrt commuter line krl" },
            { icon: "fa-plane", label: "Pesawat & Mudik", tags: "tiket pesawat travel mudik terbang liburan" },
            { icon: "fa-bicycle", label: "Sepeda & Gowes", tags: "gowes sepeda olahraga sehat" },
            { icon: "fa-road", label: "Tol & Parkir", tags: "e-toll kartu tol parkir tarif jalan" },

            // Kesehatan & Perawatan Diri
            { icon: "fa-house-medical", label: "Klinik & Rumah Sakit", tags: "rumah sakit klinik dokter faskes bpjs" },
            { icon: "fa-pills", label: "Obat & Farmasi", tags: "obat apotek vitamin paracetamol suplemen" },
            { icon: "fa-heart-pulse", label: "Pemeriksaan Kesehatan", tags: "medical checkup cek tensi lab darah sehat" },
            { icon: "fa-stethoscope", label: "Dokter & Konsultasi", tags: "spesialis dokter periksa halodoc konsultasi" },
            { icon: "fa-spa", label: "Skincare & Salon", tags: "skincare make up salon potong rambut perawatan" },
            { icon: "fa-dumbbell", label: "Fitness & Olahraga", tags: "gym senam badminton renang lari fitness sport" },
            { icon: "fa-tooth", label: "Dokter Gigi", tags: "gigi tambal behel dental tooth" },
            { icon: "fa-glasses", label: "Kacamata & Optik", tags: "optik kacamata lensa periksa mata softlens" },

            // Pendidikan, Hobi & Kantor
            { icon: "fa-graduation-cap", label: "Sekolah & Kuliah", tags: "spp sekolah kuliah uang gedung semester" },
            { icon: "fa-book", label: "Buku & Alat Tulis", tags: "atk buku tulis pensil pulpen gramedia" },
            { icon: "fa-laptop", label: "Komputer / Kursus", tags: "laptop kursus coding belajar online kuliah" },
            { icon: "fa-briefcase", label: "Pekerjaan & Kantor", tags: "kantor dinas bisnis usaha modal kerja" },

            // Hewan Peliharaan
            { icon: "fa-paw", label: "Hewan Peliharaan", tags: "hewan peliharaan pet petshop pakan" },
            { icon: "fa-cat", label: "Kucing", tags: "kucing cat food pasir whispas steril vaksin" },
            { icon: "fa-dog", label: "Anjing", tags: "anjing dog food vaksin grooming dog" },

            // Hiburan & Rekreasi
            { icon: "fa-gamepad", label: "Game & Hobi", tags: "game steam playstation nintendo hobi main" },
            { icon: "fa-ticket", label: "Bioskop & Tiket", tags: "nonton bioskop tiket konser xxi cgv rekreasi" },
            { icon: "fa-umbrella-beach", label: "Liburan & Wisata", tags: "pantai wisata liburan rekreasi jalan-jalan" },
            { icon: "fa-hotel", label: "Hotel & Penginapan", tags: "hotel vila homestay staycation nginap" },
            { icon: "fa-gift", label: "Kado & Hadiah", tags: "kado ulang tahun kado hadiah bingkisan hampers" },
            { icon: "fa-camera", label: "Foto & Dokumentasi", tags: "kamera foto studio cuci cetak video" },
            { icon: "fa-music", label: "Musik & Hiburan", tags: "musik konser instrumen lagu audio" }
        ];

        function renderCategoryColorPresets() {
            const container = document.getElementById('catColorPresetsContainer');
            if (!container) return;

            const currentColor = (document.getElementById('catInputColor')?.value || '#10B981').toUpperCase();

            let html = '';
            CATEGORY_COLOR_PRESETS.forEach(p => {
                const isSelected = p.hex.toUpperCase() === currentColor;
                html += `
                    <button type="button" onclick="selectCategoryPresetColor('${p.hex}')" 
                        class="color-preset-btn w-6 h-6 rounded-full transition-all duration-150 flex items-center justify-center relative hover:scale-115 ${isSelected ? 'ring-2 ring-offset-2 ring-[var(--text-main)] scale-110' : 'hover:opacity-90'}" 
                        style="background-color: ${p.hex};" 
                        title="${p.name} (${p.hex})">
                        ${isSelected ? '<i class="fa-solid fa-check text-[10px] text-white drop-shadow-sm"></i>' : ''}
                    </button>
                `;
            });
            container.innerHTML = html;
        }

        function selectCategoryPresetColor(hex) {
            const colorInp = document.getElementById('catInputColor');
            const hexInp = document.getElementById('catInputColorHex');
            const presetLabel = document.getElementById('catColorPresetLabel');

            if (colorInp) colorInp.value = hex;
            if (hexInp) hexInp.value = hex.toUpperCase();

            const preset = CATEGORY_COLOR_PRESETS.find(p => p.hex.toLowerCase() === hex.toLowerCase());
            if (presetLabel) {
                presetLabel.innerText = preset ? `Preset: ${preset.name}` : `Warna: ${hex.toUpperCase()}`;
            }

            renderCategoryColorPresets();
            updateCategoryModalPreview();
            renderCategoryIconGrid(document.getElementById('catIconSearchInput')?.value || '');
        }

        function handleCategoryColorChange(val) {
            let hex = String(val).trim();
            if (!hex.startsWith('#')) hex = '#' + hex;

            const colorInp = document.getElementById('catInputColor');
            const hexInp = document.getElementById('catInputColorHex');
            const presetLabel = document.getElementById('catColorPresetLabel');

            if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
                if (colorInp && colorInp.value.toLowerCase() !== hex.toLowerCase()) {
                    colorInp.value = hex;
                }
                const preset = CATEGORY_COLOR_PRESETS.find(p => p.hex.toLowerCase() === hex.toLowerCase());
                if (presetLabel) {
                    presetLabel.innerText = preset ? `Preset: ${preset.name}` : `Kustom: ${hex.toUpperCase()}`;
                }
                renderCategoryColorPresets();
                updateCategoryModalPreview();
                renderCategoryIconGrid(document.getElementById('catIconSearchInput')?.value || '');
            }
        }

        function renderCategoryIconGrid(filterQuery = '') {
            const grid = document.getElementById('categoryIconGrid');
            const countLabel = document.getElementById('iconFilterCount');
            if (!grid) return;

            const currentIcon = document.getElementById('catInputIcon')?.value || 'fa-basket-shopping';
            const currentColor = document.getElementById('catInputColor')?.value || '#10B981';
            const q = filterQuery.toLowerCase().trim();

            const filtered = CATEGORY_ICON_LIST.filter(item => {
                if (!q) return true;
                return item.icon.toLowerCase().includes(q) ||
                       item.label.toLowerCase().includes(q) ||
                       item.tags.toLowerCase().includes(q);
            });

            if (countLabel) {
                countLabel.innerText = q ? `${filtered.length} dari ${CATEGORY_ICON_LIST.length} ikon` : `${CATEGORY_ICON_LIST.length} Ikon Tersedia`;
            }

            if (filtered.length === 0) {
                grid.innerHTML = `
                    <div class="col-span-full py-6 text-center text-xs text-[var(--text-muted)] space-y-1">
                        <i class="fa-solid fa-magnifying-glass text-lg opacity-40 block mb-1"></i>
                        <span>Tidak menemukan ikon untuk kata kunci "${escapeHtml(filterQuery)}"</span>
                        <button type="button" onclick="clearCategoryIconSearch()" class="text-xs text-[var(--primary)] font-semibold hover:underline block mx-auto">Tampilkan Semua Ikon</button>
                    </div>
                `;
                return;
            }

            let html = '';
            filtered.forEach(item => {
                const isSelected = item.icon === currentIcon;
                const activeStyle = isSelected ? 
                    `background-color: ${hexToRgba(currentColor, 0.18)}; border-color: ${currentColor}; color: ${currentColor}; box-shadow: 0 0 0 1px ${currentColor};` : 
                    `border-color: var(--border-color); color: var(--text-main);`;

                html += `
                    <button type="button" onclick="selectCategoryIcon('${item.icon}')" 
                        class="icon-grid-item group h-11 rounded-lg border flex flex-col items-center justify-center p-1 transition-all duration-150 relative hover:border-[var(--primary)] hover:bg-[var(--primary-light)]/20 ${isSelected ? 'scale-105 font-bold' : 'hover:scale-105'}" 
                        style="${activeStyle}" 
                        title="${item.label} (${item.icon})">
                        <i class="fa-solid ${item.icon} text-base transition-transform group-hover:scale-110"></i>
                        <span class="text-[8px] truncate w-full text-center mt-0.5 opacity-75 font-normal leading-tight">${item.label.split(' ')[0]}</span>
                        ${isSelected ? `
                            <span class="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full flex items-center justify-center text-[8px] text-white" style="background-color: ${currentColor};">
                                <i class="fa-solid fa-check"></i>
                            </span>
                        ` : ''}
                    </button>
                `;
            });

            grid.innerHTML = html;
        }

        function selectCategoryIcon(iconClass) {
            const hiddenInp = document.getElementById('catInputIcon');
            const displayIcon = document.getElementById('selectedIconDisplay');
            const displayName = document.getElementById('selectedIconName');

            if (hiddenInp) hiddenInp.value = iconClass;
            if (displayIcon) displayIcon.className = `fa-solid ${iconClass} text-xs`;
            if (displayName) displayName.innerText = iconClass;

            renderCategoryIconGrid(document.getElementById('catIconSearchInput')?.value || '');
            updateCategoryModalPreview();
        }

        function filterCategoryIcons(query) {
            const btnClear = document.getElementById('btnClearIconSearch');
            if (btnClear) {
                if (query.trim()) btnClear.classList.remove('hidden');
                else btnClear.classList.add('hidden');
            }
            renderCategoryIconGrid(query);
        }

        function clearCategoryIconSearch() {
            const searchInp = document.getElementById('catIconSearchInput');
            const btnClear = document.getElementById('btnClearIconSearch');
            if (searchInp) searchInp.value = '';
            if (btnClear) btnClear.classList.add('hidden');
            renderCategoryIconGrid('');
        }

        function updateCategoryModalPreview() {
            const nameVal = document.getElementById('catInputName')?.value.trim() || 'Nama Kategori';
            const sheetVal = document.getElementById('catInputSheet')?.value.trim() || 'DB_Sheet';
            const colorVal = document.getElementById('catInputColor')?.value || '#10B981';
            const iconVal = document.getElementById('catInputIcon')?.value || 'fa-basket-shopping';

            const previewName = document.getElementById('catPreviewName');
            const previewSheet = document.getElementById('catPreviewSheet');
            const previewIcon = document.getElementById('catPreviewIcon');
            const previewIconBox = document.getElementById('catPreviewIconBox');
            const previewDot = document.getElementById('catPreviewDot');
            const badge = document.getElementById('selectedIconBadge');

            if (previewName) previewName.innerText = nameVal;
            if (previewSheet) previewSheet.innerText = sheetVal;
            if (previewIcon) previewIcon.className = `fa-solid ${iconVal}`;
            if (previewIconBox) {
                previewIconBox.style.backgroundColor = hexToRgba(colorVal, 0.15);
                previewIconBox.style.color = colorVal;
            }
            if (previewDot) {
                previewDot.style.backgroundColor = colorVal;
            }
            if (badge) {
                badge.style.backgroundColor = hexToRgba(colorVal, 0.15);
                badge.style.color = colorVal;
                badge.style.borderColor = hexToRgba(colorVal, 0.3);
            }

            // Update live indikator pada header accordion modal
            const headerDot = document.getElementById('modalCatHeaderColorDot');
            if (headerDot) headerDot.style.backgroundColor = colorVal;

            const headerIcon = document.getElementById('modalCatHeaderIconDisplay');
            if (headerIcon) headerIcon.className = `fa-solid ${iconVal}`;
        }

        /* ---------------- ACCORDION MODAL MASTER KATEGORI ---------------- */
        const MODAL_CATEGORY_ACCORDION_SECTIONS = ['info', 'color', 'icon', 'subcats'];

        function closeAllModalCategoryAccordions() {
            MODAL_CATEGORY_ACCORDION_SECTIONS.forEach(secId => {
                const content = document.getElementById(`cat-modal-content-${secId}`);
                const chevron = document.getElementById(`cat-modal-chevron-${secId}`);
                const card = document.getElementById(`cat-modal-card-${secId}`);
                const header = document.getElementById(`cat-modal-header-${secId}`);

                if (content) content.classList.add('hidden');
                if (chevron) chevron.innerHTML = '<i class="fa-solid fa-chevron-down text-xs text-[var(--text-muted)]"></i>';
                if (card) {
                    card.classList.remove('border-[var(--primary)]/60', 'shadow-xs', 'ring-1', 'ring-[var(--primary)]/30');
                    card.classList.add('border-[var(--border-color)]');
                }
                if (header) {
                    header.classList.remove('bg-[var(--primary-light)]/15');
                }
            });
        }

        function openModalCategoryAccordionSection(sectionId) {
            closeAllModalCategoryAccordions();
            const targetContent = document.getElementById(`cat-modal-content-${sectionId}`);
            const targetChevron = document.getElementById(`cat-modal-chevron-${sectionId}`);
            const targetCard = document.getElementById(`cat-modal-card-${sectionId}`);
            const targetHeader = document.getElementById(`cat-modal-header-${sectionId}`);

            if (targetContent) targetContent.classList.remove('hidden');
            if (targetChevron) targetChevron.innerHTML = '<i class="fa-solid fa-chevron-up text-xs text-[var(--primary)]"></i>';
            if (targetCard) {
                targetCard.classList.remove('border-[var(--border-color)]');
                targetCard.classList.add('border-[var(--primary)]/60', 'shadow-xs', 'ring-1', 'ring-[var(--primary)]/30');
            }
            if (targetHeader) {
                targetHeader.classList.add('bg-[var(--primary-light)]/15');
            }
        }

        function toggleModalCategoryAccordion(sectionId) {
            const targetContent = document.getElementById(`cat-modal-content-${sectionId}`);
            if (!targetContent) return;

            const isCurrentlyOpen = !targetContent.classList.contains('hidden');
            if (isCurrentlyOpen) {
                closeAllModalCategoryAccordions();
            } else {
                openModalCategoryAccordionSection(sectionId);
            }
        }

        /* ---------------- MANAJEMEN LIST SUB-KATEGORI MODAL ---------------- */
        let modalSubCategories = [];
        let modalEditingSubIndex = -1;

        function renderModalSubCategoriesList() {
            const container = document.getElementById('modalSubCategoriesList');
            const countBadge = document.getElementById('modalSubCatCountBadge');
            if (!container) return;

            if (countBadge) {
                countBadge.innerText = `${modalSubCategories.length} Item`;
            }

            if (modalSubCategories.length === 0) {
                container.innerHTML = `
                    <div class="p-3 text-center rounded-lg border border-dashed border-[var(--border-color)] bg-[var(--bg-surface)] text-[11px] text-[var(--text-muted)] space-y-1">
                        <i class="fa-solid fa-tags text-base opacity-40 block mb-0.5"></i>
                        <span>Belum ada sub-kategori. Masukkan nama sub-kategori di atas dan tekan <b>Tambah</b>.</span>
                    </div>
                `;
                return;
            }

            let html = '';
            modalSubCategories.forEach((sub, i) => {
                if (modalEditingSubIndex === i) {
                    html += `
                        <div class="flex items-center gap-1.5 p-1.5 rounded-lg border-2 border-[var(--primary)] bg-[var(--bg-surface)] shadow-xs">
                            <input type="text" id="inlineEditSubCat_${i}" class="custom-input text-xs py-1 px-2 font-semibold flex-1" value="${escapeHtml(sub)}" onkeydown="handleInlineEditKey(event, ${i})">
                            <button type="button" onclick="saveInlineEditSubCategory(${i})" class="btn-primary text-xs py-1 px-2.5 shrink-0" title="Simpan Perubahan">
                                <i class="fa-solid fa-check"></i>
                            </button>
                            <button type="button" onclick="cancelInlineEditSubCategory()" class="btn-secondary text-xs py-1 px-2 shrink-0 text-rose-500 hover:text-rose-700" title="Batal">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>
                    `;
                } else {
                    html += `
                        <div class="flex items-center justify-between p-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-surface)] hover:border-[var(--primary)]/40 transition group">
                            <div class="flex items-center gap-2 min-w-0">
                                <span class="w-5 h-5 rounded-md bg-[var(--primary-light)] text-[var(--primary)] flex items-center justify-center text-[10px] font-bold shrink-0">${i + 1}</span>
                                <span class="text-xs font-semibold text-[var(--text-main)] truncate">${escapeHtml(sub)}</span>
                            </div>
                            <div class="flex items-center gap-1 shrink-0 ml-2">
                                <button type="button" onclick="startEditModalSubCategory(${i})" class="w-7 h-7 rounded-md border border-[var(--border-color)] hover:border-blue-500 text-[var(--text-muted)] hover:text-blue-500 flex items-center justify-center text-xs transition" title="Ubah Nama Sub-Kategori">
                                    <i class="fa-solid fa-pen-to-square"></i>
                                </button>
                                <button type="button" onclick="removeModalSubCategory(${i})" class="w-7 h-7 rounded-md border border-[var(--border-color)] hover:border-rose-500 text-[var(--text-muted)] hover:text-rose-500 flex items-center justify-center text-xs transition" title="Hapus Sub-Kategori">
                                    <i class="fa-solid fa-trash-can"></i>
                                </button>
                            </div>
                        </div>
                    `;
                }
            });

            container.innerHTML = html;

            // Auto focus inline edit input jika ada
            if (modalEditingSubIndex >= 0) {
                setTimeout(() => {
                    const inlineInp = document.getElementById(`inlineEditSubCat_${modalEditingSubIndex}`);
                    if (inlineInp) {
                        inlineInp.focus();
                        inlineInp.select();
                    }
                }, 50);
            }
        }

        function addModalSubCategory() {
            const inp = document.getElementById('newSubCatInput');
            if (!inp) return;
            const val = inp.value.trim();
            if (!val) {
                showToast("Nama sub-kategori tidak boleh kosong!");
                inp.focus();
                return;
            }

            if (modalSubCategories.some(s => s.toLowerCase() === val.toLowerCase())) {
                showToast(`Sub-kategori "${val}" sudah ada dalam daftar!`, "warning");
                inp.focus();
                return;
            }

            modalSubCategories.push(val);
            inp.value = '';
            inp.focus();
            renderModalSubCategoriesList();
        }

        function handleSubCatInputKey(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addModalSubCategory();
            }
        }

        function startEditModalSubCategory(index) {
            modalEditingSubIndex = index;
            renderModalSubCategoriesList();
        }

        function saveInlineEditSubCategory(index) {
            const inlineInp = document.getElementById(`inlineEditSubCat_${index}`);
            if (!inlineInp) return;
            const val = inlineInp.value.trim();
            if (!val) {
                showToast("Nama sub-kategori tidak boleh kosong!");
                inlineInp.focus();
                return;
            }

            const duplicate = modalSubCategories.some((s, idx) => idx !== index && s.toLowerCase() === val.toLowerCase());
            if (duplicate) {
                showToast(`Sub-kategori "${val}" sudah ada dalam daftar!`, "warning");
                inlineInp.focus();
                return;
            }

            modalSubCategories[index] = val;
            modalEditingSubIndex = -1;
            renderModalSubCategoriesList();
        }

        function cancelInlineEditSubCategory() {
            modalEditingSubIndex = -1;
            renderModalSubCategoriesList();
        }

        function handleInlineEditKey(e, index) {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveInlineEditSubCategory(index);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelInlineEditSubCategory();
            }
        }

        function removeModalSubCategory(index) {
            modalSubCategories.splice(index, 1);
            if (modalEditingSubIndex === index) {
                modalEditingSubIndex = -1;
            } else if (modalEditingSubIndex > index) {
                modalEditingSubIndex--;
            }
            renderModalSubCategoriesList();
        }

        function openMasterCategoryModal(catData = null) {
            const modal = document.getElementById('masterCategoryModal');
            if (!modal) return;

            const isMulti = catData && catData.id === 'all';
            const catColor = catData ? catData.color : '#10B981';
            const catIcon = catData ? (catData.icon || (isMulti ? 'fa-layer-group' : 'fa-basket-shopping')) : 'fa-basket-shopping';

            document.getElementById('editCategoryId').value = catData ? catData.id : '';
            document.getElementById('catInputName').value = catData ? catData.name : '';
            const sheetInp = document.getElementById('catInputSheet');
            if (sheetInp) {
                sheetInp.value = catData ? catData.sheetName : '';
                sheetInp.readOnly = isMulti;
                sheetInp.style.opacity = isMulti ? '0.7' : '1';
            }
            document.getElementById('catInputColor').value = catColor;
            document.getElementById('catInputColorHex').value = catColor.toUpperCase();
            document.getElementById('catInputIcon').value = catIcon;

            // Inisialisasi daftar sub-kategori list model
            modalSubCategories = catData && Array.isArray(catData.subCategories) ? [...catData.subCategories] : ["Umum", "Lainnya"];
            modalEditingSubIndex = -1;
            const newSubInp = document.getElementById('newSubCatInput');
            if (newSubInp) newSubInp.value = '';
            renderModalSubCategoriesList();

            const title = document.getElementById('categoryModalTitle');
            if (title) {
                if (isMulti) title.innerText = "Pilihan Warna & Ikon: Semua Modul (Multi-Modul)";
                else title.innerText = catData ? "Edit Master Kategori" : "Tambah Master Kategori Baru";
            }

            const catBtnText = document.getElementById('btnSubmitMasterCategoryText');
            if (catBtnText) {
                catBtnText.innerText = catData ? (isMulti ? "Simpan Pengaturan Multi-Modul" : "Simpan Perubahan Kategori") : "Simpan Kategori Baru";
            }

            // Sembunyikan bagian sub-kategori jika sedang mengedit Multi-Modul
            const subCatCard = document.getElementById('cat-modal-card-subcats');
            if (subCatCard) {
                if (isMulti) subCatCard.classList.add('hidden');
                else subCatCard.classList.remove('hidden');
            }

            // Reset search input
            clearCategoryIconSearch();

            // Render presets, visual icon grid, and preview
            renderCategoryColorPresets();
            selectCategoryPresetColor(catColor);
            selectCategoryIcon(catIcon);
            updateCategoryModalPreview();

            // Jika Multi-Modul langsung buka panel Section 2 (Warna Aksen Tema)
            if (isMulti) {
                openModalCategoryAccordionSection('color');
            } else {
                openModalCategoryAccordionSection('info');
            }

            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function closeMasterCategoryModal() {
            const modal = document.getElementById('masterCategoryModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        function editMasterCategory(catId) {
            if (catId === 'all') {
                const mc = getMultiModuleConfig();
                openMasterCategoryModal({
                    id: 'all',
                    name: mc.name || 'Semua Modul (Multi-Modul)',
                    sheetName: 'DB_Multi (Virtual)',
                    color: mc.color || '#10B981',
                    icon: mc.icon || 'fa-layer-group',
                    subCategories: []
                });
                return;
            }
            const cat = state.masterCategories.find(c => c.id === catId);
            if (cat) openMasterCategoryModal(cat);
        }

        /* ========================================================
           KONFIRMASI 3 TAHAP HAPUS MASTER KATEGORI (TAB 4 SETTINGS)
           ======================================================== */
        function deleteMasterCategory(catId) {
            if (state.masterCategories.length <= 1) {
                showToast("Minimal harus tersisa 1 Master Kategori!", "warning");
                return;
            }
            openDeleteCategoryModal(catId);
        }

        async function openDeleteCategoryModal(catId) {
            const cat = state.masterCategories.find(c => c.id === catId);
            if (!cat) return;

            const modal = document.getElementById('deleteCategoryModal');
            if (!modal) {
                // Fallback jika elemen modal belum ada di DOM (dialog konfirmasi bertahap themed)
                const catName = cat.name || "Kategori ini";
                const subCount = cat.subCategories ? cat.subCategories.length : 0;
                const subList = (cat.subCategories && cat.subCategories.length > 0)
                    ? cat.subCategories.slice(0, 5).join(', ') + (subCount > 5 ? '...' : '')
                    : 'Umum';

                const conf1 = await customConfirm(`Apakah Anda yakin ingin menghapus Master Kategori "${catName}"?\nKategori ini tidak akan muncul lagi di navigasi belanja.`, {
                    title: "Hapus Master Kategori (1/2)",
                    type: "danger",
                    confirmText: "Lanjutkan"
                });
                if (!conf1) return;

                const conf2 = await customConfirm(`Perhatian! Kategori "${catName}" memiliki ${subCount} sub-kategori (${subList}) dengan sheet [${cat.sheetName}].\nTindakan ini permanen. Hapus sekarang?`, {
                    title: "Konfirmasi Final Hapus Kategori",
                    type: "danger",
                    confirmText: "Ya, Hapus Permanen"
                });
                if (!conf2) return;

                state.masterCategories = state.masterCategories.filter(c => c.id !== catId);
                persistMasterCategories();
                showToast(`Master Kategori "${catName}" berhasil dihapus.`);
                return;
            }

            state.pendingDeleteCategoryId = catId;
            state.pendingDeleteCategoryStep = 1;
            updateDeleteCategoryStepUI();

            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }

        function updateDeleteCategoryStepUI() {
            const cat = state.masterCategories.find(c => c.id === state.pendingDeleteCategoryId);
            if (!cat) return;

            const step = state.pendingDeleteCategoryStep || 1;
            const dot1 = document.getElementById('delCatStepDot1');
            const dot2 = document.getElementById('delCatStepDot2');
            const dot3 = document.getElementById('delCatStepDot3');
            const line1 = document.getElementById('delCatStepLine1');
            const line2 = document.getElementById('delCatStepLine2');
            const iconBox = document.getElementById('delCatIconContainer');
            const iconEl = document.getElementById('delCatIcon');
            const badge = document.getElementById('delCatBadge');
            const title = document.getElementById('delCatTitle');
            const preview = document.getElementById('delCatCategoryPreview');
            const desc = document.getElementById('delCatDesc');
            const extra = document.getElementById('delCatExtraInfo');
            const nextBtn = document.getElementById('btnNextDeleteCategoryStep');

            const subCount = cat.subCategories ? cat.subCategories.length : 0;
            const subList = cat.subCategories || [];

            // Category tag preview
            if (preview) {
                preview.innerHTML = `
                    <span class="w-5 h-5 rounded-md flex items-center justify-center text-xs" style="background-color: ${hexToRgba(cat.color || '#10B981', 0.15)}; color: ${cat.color || '#10B981'};">
                        <i class="fa-solid ${cat.icon || 'fa-folder'}"></i>
                    </span>
                    <span class="font-bold text-[var(--text-main)] truncate max-w-[180px]">${escapeHtml(cat.name)}</span>
                    <span class="text-[10px] text-[var(--text-muted)] font-mono">(${escapeHtml(cat.sheetName)})</span>
                `;
            }

            if (step === 1) {
                // Step 1: Warning 1 / 3
                if (dot1) dot1.className = "w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all bg-amber-500 text-white shadow-xs ring-2 ring-amber-500/30";
                if (dot2) dot2.className = "w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all bg-[var(--border-color)] text-[var(--text-muted)]";
                if (dot3) dot3.className = "w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all bg-[var(--border-color)] text-[var(--text-muted)]";
                if (line1) line1.className = "w-8 h-1 rounded-full bg-[var(--border-color)] transition-all";
                if (line2) line2.className = "w-8 h-1 rounded-full bg-[var(--border-color)] transition-all";

                if (iconBox) iconBox.className = "w-14 h-14 mx-auto rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center text-2xl shadow-inner transition-all";
                if (iconEl) iconEl.className = "fa-solid fa-triangle-exclamation";

                if (badge) {
                    badge.className = "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20";
                    badge.innerHTML = `<i class="fa-solid fa-bell"></i> Peringatan 1 dari 3`;
                }

                if (title) title.innerText = "Apakah Anda Yakin Ingin Menghapus?";
                if (desc) desc.innerHTML = `Anda akan menghapus Master Kategori <b class="text-[var(--text-main)]">${escapeHtml(cat.name)}</b>. Kategori ini tidak akan muncul lagi di daftar navigasi modul dan pengaturan master.`;
                if (extra) {
                    extra.classList.add('hidden');
                    extra.innerHTML = '';
                }

                if (nextBtn) {
                    nextBtn.className = "btn-primary !bg-amber-500 hover:!bg-amber-600 !text-white text-xs py-2.5 px-4 rounded-xl font-bold flex items-center justify-center gap-1.5 shadow-md shadow-amber-500/20 transition-all";
                    nextBtn.innerHTML = `<span>Lanjut (1/3)</span> <i class="fa-solid fa-arrow-right text-[10px]"></i>`;
                }
            } else if (step === 2) {
                // Step 2: Warning 2 / 3
                if (dot1) dot1.className = "w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all bg-orange-500 text-white shadow-xs";
                if (dot2) dot2.className = "w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all bg-orange-500 text-white shadow-xs ring-2 ring-orange-500/30";
                if (dot3) dot3.className = "w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all bg-[var(--border-color)] text-[var(--text-muted)]";
                if (line1) line1.className = "w-8 h-1 rounded-full bg-orange-500 transition-all";
                if (line2) line2.className = "w-8 h-1 rounded-full bg-[var(--border-color)] transition-all";

                if (iconBox) iconBox.className = "w-14 h-14 mx-auto rounded-2xl bg-orange-500/10 text-orange-500 flex items-center justify-center text-2xl shadow-inner transition-all";
                if (iconEl) iconEl.className = "fa-solid fa-circle-exclamation";

                if (badge) {
                    badge.className = "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-orange-500/15 text-orange-600 dark:text-orange-400 border border-orange-500/20";
                    badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Peringatan 2 dari 3: Dampak Modul`;
                }

                if (title) title.innerText = "Periksa Dampak Sub-Kategori!";
                if (desc) desc.innerHTML = `Menghapus kategori ini akan menghilangkan seluruh sub-kategori terkait dari menu input belanja dan filter riwayat.`;
                
                if (extra) {
                    extra.classList.remove('hidden');
                    extra.className = "text-[11px] p-2.5 rounded-xl bg-orange-500/5 dark:bg-orange-500/10 border border-orange-500/20 text-left space-y-1";
                    const chipsHtml = subList.length > 0
                        ? subList.map(s => `<span class="inline-block px-1.5 py-0.5 rounded bg-[var(--bg-surface)] text-[10px] font-medium border border-[var(--border-color)] mr-1 mb-1 text-[var(--text-main)]">${escapeHtml(s)}</span>`).join('')
                        : '<span class="text-[10px] text-[var(--text-muted)] italic">Tidak ada sub-kategori khusus</span>';

                    extra.innerHTML = `
                        <div class="font-bold text-orange-600 dark:text-orange-400 text-[11px] mb-1 flex items-center gap-1">
                            <i class="fa-solid fa-tags text-[10px]"></i> Sub-Kategori Terkait (${subCount}):
                        </div>
                        <div class="max-h-20 overflow-y-auto py-1">${chipsHtml}</div>
                        <div class="text-[10px] text-[var(--text-muted)] mt-1.5 pt-1.5 border-t border-orange-500/20 flex items-center gap-1">
                            <i class="fa-solid fa-table-list text-orange-500"></i>
                            <span>Tab Sheet di Google Sheets: <code class="font-mono text-orange-600 dark:text-orange-400 font-bold">${escapeHtml(cat.sheetName)}</code> (Data struk di sheet tetap aman).</span>
                        </div>
                    `;
                }

                if (nextBtn) {
                    nextBtn.className = "btn-primary !bg-orange-500 hover:!bg-orange-600 !text-white text-xs py-2.5 px-4 rounded-xl font-bold flex items-center justify-center gap-1.5 shadow-md shadow-orange-500/20 transition-all";
                    nextBtn.innerHTML = `<span>Saya Paham, Lanjut (2/3)</span> <i class="fa-solid fa-arrow-right text-[10px]"></i>`;
                }
            } else if (step === 3) {
                // Step 3: Warning 3 / 3 (FINAL)
                if (dot1) dot1.className = "w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all bg-rose-600 text-white shadow-xs";
                if (dot2) dot2.className = "w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all bg-rose-600 text-white shadow-xs";
                if (dot3) dot3.className = "w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center transition-all bg-rose-600 text-white shadow-xs ring-2 ring-rose-500/50 animate-pulse";
                if (line1) line1.className = "w-8 h-1 rounded-full bg-rose-600 transition-all";
                if (line2) line2.className = "w-8 h-1 rounded-full bg-rose-600 transition-all";

                if (iconBox) iconBox.className = "w-14 h-14 mx-auto rounded-2xl bg-rose-500/15 text-rose-600 flex items-center justify-center text-2xl shadow-lg shadow-rose-600/25 ring-2 ring-rose-500/30 transition-all";
                if (iconEl) iconEl.className = "fa-solid fa-trash-can animate-bounce";

                if (badge) {
                    badge.className = "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30";
                    badge.innerHTML = `<i class="fa-solid fa-skull-crossbones"></i> Peringatan 3 dari 3 (FINAL)`;
                }

                if (title) title.innerText = "Konfirmasi Terakhir: Hapus Permanen!";
                if (desc) desc.innerHTML = `PERINGATAN TERAKHIR: Tindakan ini bersifat <strong class="text-rose-600 dark:text-rose-400">PERMANEN</strong> dan <strong class="text-rose-600 dark:text-rose-400">TIDAK DAPAT DIBATALKAN</strong>! Apakah Anda benar-benar yakin 100% ingin menghapus kategori <b class="text-[var(--text-main)]">${escapeHtml(cat.name)}</b>?`;

                if (extra) {
                    extra.classList.remove('hidden');
                    extra.className = "text-[11px] p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-center font-bold space-y-1";
                    extra.innerHTML = `
                        <div class="flex items-center justify-center gap-1.5 text-xs">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                            <span>Klik tombol merah di bawah untuk mengeksekusi penghapusan</span>
                        </div>
                    `;
                }

                if (nextBtn) {
                    nextBtn.className = "btn-primary !bg-rose-600 hover:!bg-rose-700 !text-white text-xs py-2.5 px-4 rounded-xl font-bold flex items-center justify-center gap-1.5 shadow-lg shadow-rose-600/30 transition-all";
                    nextBtn.innerHTML = `<i class="fa-solid fa-trash-can text-xs"></i> <span>Ya, Hapus Kategori Sekarang!</span>`;
                }
            }
        }

        function nextDeleteCategoryStep() {
            const step = state.pendingDeleteCategoryStep || 1;
            if (step < 3) {
                state.pendingDeleteCategoryStep = step + 1;
                updateDeleteCategoryStepUI();
            } else {
                executeDeleteMasterCategory();
            }
        }

        function closeDeleteCategoryModal() {
            state.pendingDeleteCategoryId = null;
            state.pendingDeleteCategoryStep = 1;
            const modal = document.getElementById('deleteCategoryModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        function executeDeleteMasterCategory() {
            const catId = state.pendingDeleteCategoryId;
            if (!catId) return;

            const cat = state.masterCategories.find(c => c.id === catId);
            const catName = cat ? cat.name : "Kategori";

            state.masterCategories = state.masterCategories.filter(c => c.id !== catId);
            closeDeleteCategoryModal();
            persistMasterCategories();
            showToast(`Master Kategori "${catName}" berhasil dihapus.`, "success");
        }

        function handleSaveMasterCategory(e) {
            e.preventDefault();
            const editId = document.getElementById('editCategoryId').value.trim();
            const name = document.getElementById('catInputName').value.trim();
            const sheet = document.getElementById('catInputSheet').value.trim().replace(/\s+/g, '_');
            const color = document.getElementById('catInputColor').value;
            const icon = document.getElementById('catInputIcon').value;

            // Handle Simpan Semua Modul (Multi-Modul)
            if (editId === 'all') {
                const mc = getMultiModuleConfig();
                mc.name = name || 'Semua Modul (Multi-Modul)';
                mc.color = color || '#10B981';
                mc.icon = icon || 'fa-layer-group';
                state.multiModuleConfig = mc;
                safeStorage.setItem('saturuma_multi_module_config', JSON.stringify(mc));

                if (state.activeMasterCategoryId === 'all') {
                    applyDynamicAccentColor(mc.color);
                }

                closeMasterCategoryModal();
                persistMasterCategories();
                showToast("Pilihan warna dan ikon Semua Modul berhasil disimpan!", "success");
                return;
            }

            // Jika user mengetik di input baru tapi belum mengklik tombol Tambah, otomatis sertakan
            const pendingInput = document.getElementById('newSubCatInput')?.value.trim();
            if (pendingInput && !modalSubCategories.some(s => s.toLowerCase() === pendingInput.toLowerCase())) {
                modalSubCategories.push(pendingInput);
            }

            const subCategories = modalSubCategories.filter(s => s && s.trim().length > 0);

            if (editId) {
                state.masterCategories = state.masterCategories.map(c => {
                    if (c.id === editId) {
                        return { ...c, name, sheetName: sheet, color, icon, subCategories: subCategories.length > 0 ? subCategories : ["Umum", "Lainnya"] };
                    }
                    return c;
                });
            } else {
                const newCat = {
                    id: "cat_" + Date.now(),
                    name: name,
                    sheetName: sheet,
                    color: color,
                    icon: icon,
                    subCategories: subCategories.length > 0 ? subCategories : ["Umum", "Lainnya"]
                };
                state.masterCategories.push(newCat);
            }

            closeMasterCategoryModal();
            persistMasterCategories();
            showToast("Master Kategori berhasil disimpan!");
        }

        function persistMasterCategories() {
            safeStorage.setItem('saturuma_categories', JSON.stringify(state.masterCategories));
            updateCategoryDropdowns();
            renderCategoryPills();
            renderSidebarCategories();
            renderSettingsCategories();

            // Sinkronkan banner di menu Input dan daftar Riwayat dengan konfigurasi terbaru
            const formSelect = document.getElementById('formMasterCategorySelect');
            if (formSelect) {
                handleFormCategoryChange(formSelect.value);
            }
            if (state.currentView === 'history') {
                filterHistoryList();
            }

            if (typeof google !== 'undefined' && google.script && google.script.run) {
                google.script.run
                    .withSuccessHandler(function(resp) {
                        if (resp && resp.categories) state.masterCategories = resp.categories;
                    })
                    .saveMasterCategories(state.masterCategories);
            }
        }

        function saveGeminiSettings() {
            const key = document.getElementById('settingsGeminiApiKey')?.value.trim();
            const model = document.getElementById('settingsAiModelSelect')?.value;

            safeStorage.setItem('saturuma_gemini_key', key || '');
            safeStorage.setItem('saturuma_ai_model', normalizeGeminiModelName(model));

            if (typeof google !== 'undefined' && google.script && google.script.run) {
                google.script.run.saveGeminiApiKey(key);
            }
            showToast("Pengaturan AI Gemini berhasil disimpan!");
        }

        function toggleApiKeyVisibility() {
            const inp = document.getElementById('settingsGeminiApiKey');
            const icon = document.getElementById('apiKeyEyeIcon');
            if (inp && icon) {
                if (inp.type === 'password') {
                    inp.type = 'text';
                    icon.classList.remove('fa-eye');
                    icon.classList.add('fa-eye-slash');
                } else {
                    inp.type = 'password';
                    icon.classList.remove('fa-eye-slash');
                    icon.classList.add('fa-eye');
                }
            }
        }

        /* ========================================================
           8. TARGET ANGGARAN & REALISASI PER MODUL KATEGORI
           ======================================================== */
        function getCategoryBudget(catId) {
            if (!state.categoryBudgets) {
                state.categoryBudgets = {};
                try {
                    const saved = safeStorage.getItem('saturuma_category_budgets');
                    if (saved) state.categoryBudgets = JSON.parse(saved);
                } catch(e) {}
            }

            if (state.categoryBudgets && state.categoryBudgets[catId] !== undefined) {
                return Number(state.categoryBudgets[catId]) || 0;
            }

            const cat = state.masterCategories.find(c => c.id === catId || c.sheetName === catId);
            if (cat && cat.budget !== undefined) {
                return Number(cat.budget) || 0;
            }

            // Distribusi default awal jika belum pernah diatur
            const defaultMap = {
                dapur: 3500000,
                tagihan: 2500000,
                bayi: 1500000,
                transport: 1500000,
                tabungan: 1000000
            };
            return defaultMap[catId] !== undefined ? defaultMap[catId] : 1000000;
        }

        function getTotalCategoryBudgets() {
            let total = 0;
            state.masterCategories.forEach(cat => {
                total += getCategoryBudget(cat.id);
            });
            return total > 0 ? total : (state.stats.monthlyBudget || 10000000);
        }

        function renderCategoryBudgetInputs() {
            const container = document.getElementById('categoryBudgetInputsContainer');
            const countBadge = document.getElementById('budgetCategoryCountBadge');
            if (!container) return;

            if (countBadge) countBadge.innerText = `${state.masterCategories.length} Modul`;

            // Realisasi bulan berjalan untuk referensi saat menentukan pagu anggaran modul
            const now = new Date();
            const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const thisMonthEntries = state.entries.filter(e => (e.date || '').substring(0, 7) === curYM);
            const catSpentMap = {};
            thisMonthEntries.forEach(e => {
                const cId = e.masterCategoryId || (state.masterCategories.find(c => c.name === e.masterCategoryName)?.id);
                if (cId) catSpentMap[cId] = (catSpentMap[cId] || 0) + (Number(e.cost) || 0);
            });

            let html = '';
            state.masterCategories.forEach(cat => {
                const budgetVal = getCategoryBudget(cat.id);
                const spentVal = catSpentMap[cat.id] || 0;
                const isOver = budgetVal > 0 && spentVal > budgetVal;
                html += `
                    <div class="category-card p-2.5 sm:p-3 bg-[var(--bg-surface)] rounded-xl border border-[var(--border-color)] space-y-2 hover:border-[var(--primary)]/40 transition-all shadow-2xs" style="${getCategoryCardStyle(cat.color, { borderLeftWidth: '4px', radius: '12px' })}">
                        <!-- Baris Atas: Icon, Nama, dan Realisasi -->
                        <div class="flex items-center justify-between gap-2">
                            <div class="flex items-center gap-2 min-w-0">
                                <span class="w-6 h-6 rounded-md flex items-center justify-center text-xs shrink-0 font-bold" style="background-color: ${hexToRgba(cat.color, 0.15)}; color: ${cat.color};">
                                    <i class="fa-solid ${cat.icon || 'fa-folder'}"></i>
                                </span>
                                <h4 class="text-xs font-bold text-[var(--text-main)] truncate">${escapeHtml(cat.name)}</h4>
                            </div>
                            <span class="text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${isOver ? 'bg-rose-500/10 text-rose-500 border-rose-500/20 font-bold' : 'bg-[var(--bg-main)] text-[var(--text-muted)] border-[var(--border-color)]'}">
                                Realisasi: <b class="${isOver ? 'text-rose-500' : 'text-[var(--text-main)]'}">${formatRupiah(spentVal)}</b>
                            </span>
                        </div>

                        <!-- Baris Bawah: Input Cepat & Preset Tombol Ringkas -->
                        <div class="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
                            <div class="relative flex-1 min-w-[120px]">
                                <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] font-bold text-[var(--text-muted)]">Rp</span>
                                <input type="text" inputmode="numeric" id="catBudgetInput_${cat.id}" 
                                    data-cat-id="${cat.id}"
                                    value="${formatThousand(budgetVal)}" 
                                    placeholder="0"
                                    onfocus="this.select()"
                                    onkeydown="if(event.key==='Enter'){saveCategoryBudgets();}"
                                    oninput="handleCategoryBudgetInputChange('${cat.id}', this)"
                                    class="custom-input text-xs font-bold pl-8 pr-2.5 py-1.5 w-full text-[var(--text-main)]">
                            </div>
                            <div class="flex items-center gap-1 shrink-0">
                                <button type="button" onclick="setCategoryBudgetPreset('${cat.id}', 500000)" class="btn-secondary text-[10px] py-1 px-1.5 font-semibold" title="500 Ribu">500k</button>
                                <button type="button" onclick="setCategoryBudgetPreset('${cat.id}', 1000000)" class="btn-secondary text-[10px] py-1 px-1.5 font-semibold" title="1 Juta">1 Jt</button>
                                <button type="button" onclick="setCategoryBudgetPreset('${cat.id}', 2000000)" class="btn-secondary text-[10px] py-1 px-1.5 font-semibold" title="2 Juta">2 Jt</button>
                                <button type="button" onclick="adjustCategoryBudgetStep('${cat.id}', 250000)" class="btn-secondary text-[10px] py-1 px-1.5 text-emerald-600 font-bold" title="Tambah 250 Ribu">+250k</button>
                                <button type="button" onclick="setCategoryBudgetPreset('${cat.id}', 0)" class="btn-secondary text-[10px] py-1 px-1.5 text-rose-500 hover:text-rose-700 font-bold" title="Kosongkan (0)">0</button>
                            </div>
                        </div>
                    </div>
                `;
            });

            container.innerHTML = html;
            updatePlannedBudgetTotalDisplay();
        }

        function updatePlannedBudgetTotalDisplay() {
            let total = 0;
            state.masterCategories.forEach(cat => {
                const inp = document.getElementById(`catBudgetInput_${cat.id}`);
                if (inp) {
                    total += parseThousand(inp.value) || 0;
                } else {
                    total += getCategoryBudget(cat.id);
                }
            });

            const display = document.getElementById('budgetPlanTotalDisplay');
            if (display) display.textContent = formatRupiah(total);

            const hiddenInp = document.getElementById('settingsMonthlyBudgetInput');
            if (hiddenInp) hiddenInp.value = formatThousand(total);
        }

        function handleCategoryBudgetInputChange(catId, inputEl) {
            handleThousandInput(inputEl);
            updatePlannedBudgetTotalDisplay();
        }

        function setCategoryBudgetPreset(catId, amount) {
            const inp = document.getElementById(`catBudgetInput_${catId}`);
            if (inp) {
                inp.value = formatThousand(amount);
                updatePlannedBudgetTotalDisplay();
            }
        }

        function adjustCategoryBudgetStep(catId, delta) {
            const inp = document.getElementById(`catBudgetInput_${catId}`);
            if (inp) {
                const current = parseThousand(inp.value) || 0;
                const nextVal = Math.max(current + delta, 0);
                inp.value = formatThousand(nextVal);
                updatePlannedBudgetTotalDisplay();
            }
        }

        function applyPresetBudgetDistribution(totalAmount) {
            if (!state.masterCategories || state.masterCategories.length === 0) return;

            const weights = {
                dapur: 0.35,
                tagihan: 0.25,
                bayi: 0.15,
                transport: 0.15,
                tabungan: 0.10
            };

            let remainingWeight = 0;
            let matchedWeight = 0;
            state.masterCategories.forEach(cat => {
                if (weights[cat.id]) matchedWeight += weights[cat.id];
                else remainingWeight++;
            });

            let allocatedTotal = 0;
            state.masterCategories.forEach((cat, idx) => {
                let weight = weights[cat.id];
                if (!weight) {
                    weight = remainingWeight > 0 ? (1 - matchedWeight) / remainingWeight : 1 / state.masterCategories.length;
                }
                let share = Math.round((totalAmount * weight) / 50000) * 50000;
                if (idx === state.masterCategories.length - 1) {
                    share = Math.max(totalAmount - allocatedTotal, 0);
                }
                allocatedTotal += share;

                const inp = document.getElementById(`catBudgetInput_${cat.id}`);
                if (inp) inp.value = formatThousand(share);
            });

            updatePlannedBudgetTotalDisplay();
            showToast(`Template anggaran ${formatRupiah(totalAmount)} diterapkan ke seluruh modul!`);
        }

        function resetAllCategoryBudgets() {
            state.masterCategories.forEach(cat => {
                const inp = document.getElementById(`catBudgetInput_${cat.id}`);
                if (inp) inp.value = '0';
            });
            updatePlannedBudgetTotalDisplay();
            showToast("Semua batas anggaran modul direset ke 0.");
        }

        function saveCategoryBudgets() {
            if (!state.categoryBudgets) state.categoryBudgets = {};

            let total = 0;
            state.masterCategories.forEach(cat => {
                const inp = document.getElementById(`catBudgetInput_${cat.id}`);
                let budgetVal = 0;
                if (inp) {
                    budgetVal = parseThousand(inp.value) || 0;
                } else {
                    budgetVal = getCategoryBudget(cat.id);
                }
                state.categoryBudgets[cat.id] = budgetVal;
                cat.budget = budgetVal;
                total += budgetVal;
            });

            state.stats.monthlyBudget = total;

            safeStorage.setItem('saturuma_category_budgets', JSON.stringify(state.categoryBudgets));
            safeStorage.setItem('saturuma_categories', JSON.stringify(state.masterCategories));

            if (typeof google !== 'undefined' && google.script && google.script.run) {
                google.script.run.saveMonthlyBudget(state.stats.monthlyBudget);
            }

            renderDashboard();
            renderBudgetSubMenu();
            showToast("Batas anggaran per modul kategori berhasil disimpan!", "success");
        }

        function setBudgetPreset(val) {
            applyPresetBudgetDistribution(val);
        }

        function saveBudgetFromSettings() {
            saveCategoryBudgets();
        }

        function switchDashboardSubMenu(tab) {
            state.dashboardSubMenu = tab || 'overview';
            const btnOverview = document.getElementById('dtab-overview');
            const btnBudget = document.getElementById('dtab-budget');
            const contentOverview = document.getElementById('dashContentOverview');
            const contentBudget = document.getElementById('dashContentBudget');

            const activeClass = "px-3.5 py-2 sm:py-1.5 rounded-xl text-xs font-bold transition-all bg-[var(--primary)] text-white border border-[var(--primary)] shadow-xs flex items-center justify-center gap-2 text-center";
            const inactiveClass = "px-3.5 py-2 sm:py-1.5 rounded-xl text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-main)] transition-all bg-transparent border border-transparent hover:bg-[var(--bg-main)]/50 flex items-center justify-center gap-2 text-center";

            if (tab === 'budget') {
                if (btnOverview) btnOverview.className = inactiveClass;
                if (btnBudget) btnBudget.className = activeClass;
                if (contentOverview) contentOverview.classList.add('hidden');
                if (contentBudget) contentBudget.classList.remove('hidden');
                renderCategoryBudgetInputs();
            } else {
                if (btnOverview) btnOverview.className = activeClass;
                if (btnBudget) btnBudget.className = inactiveClass;
                if (contentOverview) contentOverview.classList.remove('hidden');
                if (contentBudget) contentBudget.classList.add('hidden');
                renderDashboard();
            }
        }

        function openBudgetModal() {
            setAppMode('dashboard');
            switchDashboardSubMenu('budget');
        }

        function renderBudgetSubMenu() {
            const budget = getTotalCategoryBudgets();
            state.stats.monthlyBudget = budget;

            // Populate input total jika ada di halaman target anggaran
            const inp = document.getElementById('settingsMonthlyBudgetInput');
            if (inp) inp.value = formatThousand(budget);

            const planTotalDisp = document.getElementById('budgetPlanTotalDisplay');
            if (planTotalDisp) planTotalDisp.textContent = formatRupiah(budget);
        }

        /* ---------------- PHOTO PREVIEW MODAL ---------------- */
        function openPhotoPreviewModal(title, url) {
            const modal = document.getElementById('photoPreviewModal');
            const titleEl = document.getElementById('photoModalTitle');
            const imgEl = document.getElementById('photoModalImg');
            const pdfEl = document.getElementById('photoModalPdfFrame');
            const linkEl = document.getElementById('photoModalExternalLink');

            let displayUrl = url || '';
            // Konversi Google Drive file URL ke direct thumbnail URL jika berupa file gambar
            if (displayUrl.includes('drive.google.com/file/d/')) {
                const match = displayUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
                if (match && match[1] && !displayUrl.toLowerCase().includes('.pdf')) {
                    displayUrl = 'https://drive.google.com/thumbnail?id=' + match[1] + '&sz=w1200';
                }
            }

            if (titleEl) titleEl.innerText = title || "Pratinjau Bukti";
            if (linkEl) linkEl.href = url || "#";

            const isPdf = displayUrl.toLowerCase().includes('.pdf');
            if (isPdf) {
                if (imgEl) imgEl.classList.add('hidden');
                if (pdfEl) { pdfEl.src = displayUrl; pdfEl.classList.remove('hidden'); }
            } else {
                if (pdfEl) pdfEl.classList.add('hidden');
                if (imgEl) { imgEl.src = displayUrl; imgEl.classList.remove('hidden'); }
            }

            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            }
        }
        function closePhotoPreviewModal() {
            const modal = document.getElementById('photoPreviewModal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
        }

        /* ========================================================
           9. SINKRONISASI DATA & BACKEND INTEGRATION
           ======================================================== */
        function showDashboardSkeletons() {
            const kpiTotal = document.getElementById('kpiTotalSpent');
            const kpiDaily = document.getElementById('kpiDailyAvg');
            const kpiBudget = document.getElementById('kpiBudgetComparison');
            const kpiTop = document.getElementById('kpiTopCategory');
            const breakdownContainer = document.getElementById('categoryBreakdownList');
            const recentContainer = document.getElementById('dashboardRecentList');

            if (kpiTotal) kpiTotal.innerHTML = `<span class="inline-block w-28 h-7 skeleton-shimmer"></span>`;
            if (kpiDaily) kpiDaily.innerHTML = `<span class="inline-block w-24 h-7 skeleton-shimmer"></span>`;
            if (kpiBudget) kpiBudget.innerHTML = `<span class="inline-block w-20 h-7 skeleton-shimmer"></span>`;
            if (kpiTop) kpiTop.innerHTML = `<span class="inline-block w-24 h-6 skeleton-shimmer"></span>`;

            if (breakdownContainer) {
                breakdownContainer.innerHTML = Array(5).fill(0).map(() => `
                    <div class="p-2.5 rounded-xl border border-[var(--border-color)] space-y-1.5">
                        <div class="flex items-center justify-between gap-1.5">
                            <div class="flex items-center gap-2 w-3/4">
                                <div class="w-6 h-6 rounded-md skeleton-shimmer flex-shrink-0"></div>
                                <div class="h-3 skeleton-shimmer w-2/3"></div>
                            </div>
                            <div class="h-3 skeleton-shimmer w-7"></div>
                        </div>
                        <div class="pt-1 border-t border-[var(--border-color)]/30 space-y-1">
                            <div class="flex justify-between">
                                <div class="h-3 skeleton-shimmer w-16"></div>
                                <div class="h-3 skeleton-shimmer w-14"></div>
                            </div>
                            <div class="h-1 rounded-full skeleton-shimmer w-full"></div>
                        </div>
                    </div>
                `).join('');
            }

            if (recentContainer) {
                recentContainer.innerHTML = Array(3).fill(0).map(() => `
                    <div class="p-3 rounded-xl border border-[var(--border-color)] flex items-center justify-between">
                        <div class="flex items-center gap-2.5 w-1/2">
                            <div class="w-8 h-8 rounded-lg skeleton-shimmer flex-shrink-0"></div>
                            <div class="space-y-1.5 w-full">
                                <div class="h-3.5 skeleton-shimmer w-3/4"></div>
                                <div class="h-2.5 skeleton-shimmer w-1/2"></div>
                            </div>
                        </div>
                        <div class="h-4 skeleton-shimmer w-20"></div>
                    </div>
                `).join('');
            }
        }

        function showHistorySkeletons() {
            const container = document.getElementById('historyReceiptsContainer');
            if (!container) return;
            container.innerHTML = Array(3).fill(0).map(() => `
                <div class="glass-card p-4 space-y-3">
                    <div class="flex items-center justify-between pb-3 border-b border-[var(--border-color)]">
                        <div class="flex items-center gap-3 w-1/2">
                            <div class="w-10 h-10 rounded-xl skeleton-shimmer flex-shrink-0"></div>
                            <div class="space-y-1.5 w-full">
                                <div class="h-4 skeleton-shimmer w-3/4"></div>
                                <div class="h-3 skeleton-shimmer w-1/2"></div>
                            </div>
                        </div>
                        <div class="space-y-1.5 w-24">
                            <div class="h-3 skeleton-shimmer w-full"></div>
                            <div class="h-5 skeleton-shimmer w-full"></div>
                        </div>
                    </div>
                    <div class="p-3 rounded-xl border border-[var(--border-color)] space-y-2">
                        <div class="h-3.5 skeleton-shimmer w-5/6"></div>
                        <div class="h-3.5 skeleton-shimmer w-4/6"></div>
                    </div>
                </div>
            `).join('');
        }

        function loadEntriesFromBackend() {
            const syncIcon = document.getElementById('syncIcon');
            if (syncIcon) syncIcon.classList.add('fa-spin');
            if (!state.receipts || state.receipts.length === 0) {
                showDashboardSkeletons();
                showHistorySkeletons();
            }

            if (typeof google !== 'undefined' && google.script && google.script.run) {
                google.script.run
                    .withSuccessHandler(function(resp) {
                        if (syncIcon) syncIcon.classList.remove('fa-spin');
                        if (resp && resp.success) {
                            state.entries = resp.entries || [];
                            state.receipts = resp.receipts || [];
                            state.stats = resp.stats || state.stats;
                            state.metadata = resp.metadata || null;

                            if (resp.metadata && resp.metadata.categories) {
                                state.masterCategories = resp.metadata.categories;
                            }

                            updateMetadataLinks(state.metadata);
                            updateCategoryDropdowns();
                            renderCategoryPills();
                            renderSidebarCategories();
                            renderDashboard();
                            filterHistoryList();
                        }
                    })
                    .withFailureHandler(function(err) {
                        if (syncIcon) syncIcon.classList.remove('fa-spin');
                        showToast("Gagal memuat dari Sheets: " + err.message);
                    })
                    .getRecentEntries("all", 500, (state.currentUser && state.currentUser.customSpreadsheetId) || "");
            } else {
                // Standalone Mock Fallback
                setTimeout(() => {
                    if (syncIcon) syncIcon.classList.remove('fa-spin');
                    loadMockData();
                }, 400);
            }
        }

        function updateMetadataLinks(meta) {
            if (!meta) return;
            if (state.currentUser && state.currentUser.customSpreadsheetUrl) {
                meta.spreadsheetUrl = state.currentUser.customSpreadsheetUrl;
            }
            const sheetLink = document.getElementById('btnOpenSpreadsheet');
            const driveLink = document.getElementById('btnOpenDrive');
            const metaSheetLink = document.getElementById('btnMetaSpreadsheetLink');
            const metaDriveLink = document.getElementById('btnMetaDriveLink');

            if (sheetLink && meta.spreadsheetUrl) sheetLink.href = meta.spreadsheetUrl;
            if (driveLink && meta.driveFolderUrl) driveLink.href = meta.driveFolderUrl;
            if (metaSheetLink && meta.spreadsheetUrl) {
                metaSheetLink.href = meta.spreadsheetUrl;
                const userSheetLink = document.getElementById('btnOpenUserSheetLink');
                if (userSheetLink) userSheetLink.href = meta.spreadsheetUrl;
            }
            if (metaDriveLink && meta.driveFolderUrl) metaDriveLink.href = meta.driveFolderUrl;
        }

        function loadMockData() {
            const saved = safeStorage.getItem('saturuma_entries');
            const savedReceipts = safeStorage.getItem('saturuma_receipts');
            if (saved) {
                try {
                    state.entries = JSON.parse(saved);
                    if (savedReceipts) {
                        try {
                            state.receipts = JSON.parse(savedReceipts);
                        } catch(re) {
                            rebuildReceiptsFromEntries();
                        }
                    } else {
                        rebuildReceiptsFromEntries();
                    }
                    renderDashboard();
                    filterHistoryList();
                    return;
                } catch(e) {}
            }

            // Mock Data Default
            const now = new Date();
            const todayStr = now.toISOString().split('T')[0];
            const getPastDateStr = (mOffset, day) => {
                const pd = new Date(now.getFullYear(), now.getMonth() - mOffset, 1);
                const maxDay = new Date(pd.getFullYear(), pd.getMonth() + 1, 0).getDate();
                const actualDay = Math.min(day, maxDay);
                return `${pd.getFullYear()}-${String(pd.getMonth() + 1).padStart(2, '0')}-${String(actualDay).padStart(2, '0')}`;
            };

            const sampleEntries = [
                {
                    rowIndex: 2,
                    masterCategoryId: "dapur",
                    masterCategoryName: "Belanja Dapur & Groceries",
                    masterSheetName: "DB_Dapur",
                    timestamp: todayStr + " 08:30:00",
                    date: todayStr,
                    receiptId: "REC-20261105-001",
                    merchant: "Super Indo",
                    itemName: "Beras Ramos 5kg",
                    subCategory: "Sembako & Bumbu",
                    qty: 1,
                    cost: 74500,
                    discount: 5000,
                    tax: 0,
                    other: 0
                },
                {
                    rowIndex: 3,
                    masterCategoryId: "dapur",
                    masterCategoryName: "Belanja Dapur & Groceries",
                    masterSheetName: "DB_Dapur",
                    timestamp: todayStr + " 08:30:00",
                    date: todayStr,
                    receiptId: "REC-20261105-001",
                    merchant: "Super Indo",
                    itemName: "Minyak Goreng 2L",
                    subCategory: "Sembako & Bumbu",
                    qty: 1,
                    cost: 36000,
                    discount: 0,
                    tax: 0,
                    other: 0
                },
                {
                    rowIndex: 4,
                    masterCategoryId: "bayi",
                    masterCategoryName: "Kebutuhan Bayi",
                    masterSheetName: "DB_Bayi",
                    timestamp: todayStr + " 10:15:00",
                    date: todayStr,
                    receiptId: "REC-20261105-002",
                    merchant: "Mothercare",
                    itemName: "Popok MamyPoko M44",
                    subCategory: "Popok",
                    qty: 2,
                    cost: 170000,
                    discount: 10000,
                    tax: 0,
                    other: 0
                },
                {
                    rowIndex: 5,
                    masterCategoryId: "tagihan",
                    masterCategoryName: "Tagihan & Rutinitas Rumah",
                    masterSheetName: "DB_Tagihan",
                    timestamp: todayStr + " 11:00:00",
                    date: todayStr,
                    receiptId: "REC-20261105-003",
                    merchant: "PLN Token Listrik",
                    itemName: "Token Listrik 2200VA",
                    subCategory: "Listrik PLN",
                    qty: 1,
                    cost: 500000,
                    discount: 0,
                    tax: 0,
                    other: 2500
                },
                {
                    rowIndex: 6,
                    masterCategoryId: "transport",
                    masterCategoryName: "Transportasi & Kendaraan",
                    masterSheetName: "DB_Transport",
                    timestamp: todayStr + " 13:40:00",
                    date: todayStr,
                    receiptId: "REC-20261105-004",
                    merchant: "SPBU Pertamina",
                    itemName: "Bensin Pertamax",
                    subCategory: "Bensin & BBM",
                    qty: 1,
                    cost: 250000,
                    discount: 0,
                    tax: 0,
                    other: 0
                },
                // Data Histori 1 Bulan Lalu (M-1)
                {
                    rowIndex: 7,
                    masterCategoryId: "dapur",
                    masterCategoryName: "Belanja Dapur & Groceries",
                    masterSheetName: "DB_Dapur",
                    timestamp: getPastDateStr(1, 10) + " 09:00:00",
                    date: getPastDateStr(1, 10),
                    receiptId: "REC-HIST-M1-01",
                    merchant: "Super Indo",
                    itemName: "Belanja Mingguan Sembako",
                    subCategory: "Sembako & Bumbu",
                    qty: 1,
                    cost: 385000,
                    discount: 15000,
                    tax: 0,
                    other: 0
                },
                {
                    rowIndex: 8,
                    masterCategoryId: "tagihan",
                    masterCategoryName: "Tagihan & Rutinitas Rumah",
                    masterSheetName: "DB_Tagihan",
                    timestamp: getPastDateStr(1, 15) + " 10:30:00",
                    date: getPastDateStr(1, 15),
                    receiptId: "REC-HIST-M1-02",
                    merchant: "PLN Token Listrik",
                    itemName: "Token Listrik Bulanan",
                    subCategory: "Listrik PLN",
                    qty: 1,
                    cost: 500000,
                    discount: 0,
                    tax: 0,
                    other: 2500
                },
                {
                    rowIndex: 9,
                    masterCategoryId: "transport",
                    masterCategoryName: "Transportasi & Kendaraan",
                    masterSheetName: "DB_Transport",
                    timestamp: getPastDateStr(1, 20) + " 14:15:00",
                    date: getPastDateStr(1, 20),
                    receiptId: "REC-HIST-M1-03",
                    merchant: "SPBU Pertamina",
                    itemName: "Bensin Pertamax",
                    subCategory: "Bensin & BBM",
                    qty: 1,
                    cost: 300000,
                    discount: 0,
                    tax: 0,
                    other: 0
                },
                // Data Histori 2 Bulan Lalu (M-2)
                {
                    rowIndex: 10,
                    masterCategoryId: "dapur",
                    masterCategoryName: "Belanja Dapur & Groceries",
                    masterSheetName: "DB_Dapur",
                    timestamp: getPastDateStr(2, 8) + " 10:00:00",
                    date: getPastDateStr(2, 8),
                    receiptId: "REC-HIST-M2-01",
                    merchant: "Super Indo",
                    itemName: "Groceries Bulanan Lengkap",
                    subCategory: "Sembako & Bumbu",
                    qty: 1,
                    cost: 520000,
                    discount: 25000,
                    tax: 0,
                    other: 0
                },
                {
                    rowIndex: 11,
                    masterCategoryId: "tagihan",
                    masterCategoryName: "Tagihan & Rutinitas Rumah",
                    masterSheetName: "DB_Tagihan",
                    timestamp: getPastDateStr(2, 12) + " 11:20:00",
                    date: getPastDateStr(2, 12),
                    receiptId: "REC-HIST-M2-02",
                    merchant: "PLN Token Listrik",
                    itemName: "Token Listrik Bulanan",
                    subCategory: "Listrik PLN",
                    qty: 1,
                    cost: 450000,
                    discount: 0,
                    tax: 0,
                    other: 2500
                },
                // Data Histori 3 Bulan Lalu (M-3)
                {
                    rowIndex: 12,
                    masterCategoryId: "dapur",
                    masterCategoryName: "Belanja Dapur & Groceries",
                    masterSheetName: "DB_Dapur",
                    timestamp: getPastDateStr(3, 14) + " 16:00:00",
                    date: getPastDateStr(3, 14),
                    receiptId: "REC-HIST-M3-01",
                    merchant: "Super Indo",
                    itemName: "Kebutuhan Dapur & Sayuran",
                    subCategory: "Sembako & Bumbu",
                    qty: 1,
                    cost: 410000,
                    discount: 10000,
                    tax: 0,
                    other: 0
                },
                {
                    rowIndex: 13,
                    masterCategoryId: "tagihan",
                    masterCategoryName: "Tagihan & Rutinitas Rumah",
                    masterSheetName: "DB_Tagihan",
                    timestamp: getPastDateStr(3, 18) + " 09:40:00",
                    date: getPastDateStr(3, 18),
                    receiptId: "REC-HIST-M3-02",
                    merchant: "PLN Token Listrik",
                    itemName: "Token Listrik Bulanan",
                    subCategory: "Listrik PLN",
                    qty: 1,
                    cost: 500000,
                    discount: 0,
                    tax: 0,
                    other: 2500
                },
                // Data Histori 4 Bulan Lalu (M-4)
                {
                    rowIndex: 14,
                    masterCategoryId: "dapur",
                    masterCategoryName: "Belanja Dapur & Groceries",
                    masterSheetName: "DB_Dapur",
                    timestamp: getPastDateStr(4, 7) + " 11:15:00",
                    date: getPastDateStr(4, 7),
                    receiptId: "REC-HIST-M4-01",
                    merchant: "Super Indo",
                    itemName: "Belanja Dapur Mingguan",
                    subCategory: "Sembako & Bumbu",
                    qty: 1,
                    cost: 360000,
                    discount: 0,
                    tax: 0,
                    other: 0
                },
                {
                    rowIndex: 15,
                    masterCategoryId: "transport",
                    masterCategoryName: "Transportasi & Kendaraan",
                    masterSheetName: "DB_Transport",
                    timestamp: getPastDateStr(4, 21) + " 15:30:00",
                    date: getPastDateStr(4, 21),
                    receiptId: "REC-HIST-M4-02",
                    merchant: "SPBU Pertamina",
                    itemName: "Bensin & Servis Rutin",
                    subCategory: "Bensin & BBM",
                    qty: 1,
                    cost: 350000,
                    discount: 0,
                    tax: 0,
                    other: 0
                }
            ];

            state.entries = sampleEntries;
            rebuildReceiptsFromEntries();
            saveMockData(sampleEntries, state.receipts);
            renderDashboard();
            filterHistoryList();
        }

        function saveMockData(entries, receipts) {
            if (entries) safeStorage.setItem('saturuma_entries', JSON.stringify(entries));
            const recsToSave = receipts || state.receipts;
            if (recsToSave) safeStorage.setItem('saturuma_receipts', JSON.stringify(recsToSave));
        }

        function rebuildReceiptsFromEntries() {
            const map = {};
            state.entries.forEach(e => {
                const rId = e.receiptId || "REC-LEGACY";
                if (!map[rId]) {
                    map[rId] = {
                        receiptId: rId,
                        masterCategoryId: e.masterCategoryId,
                        masterCategoryName: e.masterCategoryName,
                        masterSheetName: e.masterSheetName,
                        date: e.date,
                        merchant: e.merchant,
                        userId: e.userId || '',
                        createdByName: e.createdByName || (e.userId ? (e.userId === 'admin' ? 'Administrator' : e.userId) : ''),
                        totalCost: 0,
                        subtotal: 0,
                        totalDiscount: 0,
                        totalTax: 0,
                        totalOther: 0,
                        totalAmount: 0,
                        receiptPhotoUrl: e.receiptPhotoUrl || '',
                        items: []
                    };
                } else {
                    // Jika struk ini memiliki item dari modul kategori berbeda
                    if (map[rId].masterCategoryId !== 'all' && e.masterCategoryId && map[rId].masterCategoryId !== e.masterCategoryId) {
                        map[rId].masterCategoryId = 'all';
                        map[rId].masterCategoryName = 'Multi-Modul';
                        map[rId].masterSheetName = 'DB_Multi';
                    }
                }
                map[rId].receiptPhotoUrl = map[rId].receiptPhotoUrl || e.receiptPhotoUrl || '';
                const lineCost = (Number(e.cost) || 0) * (Number(e.qty) || 1);
                map[rId].totalCost += lineCost;
                map[rId].subtotal = map[rId].totalCost;
                map[rId].totalDiscount += (Number(e.discount) || 0);
                map[rId].totalTax += (Number(e.tax) || 0);
                map[rId].totalOther += (Number(e.other) || 0);
                map[rId].totalAmount = Math.max(0, map[rId].totalCost - map[rId].totalDiscount + map[rId].totalTax + map[rId].totalOther);
                map[rId].items.push({
                    itemName: e.itemName,
                    subCategory: e.subCategory,
                    qty: e.qty,
                    cost: e.cost,
                    discount: Number(e.discount) || 0,
                    tax: Number(e.tax) || 0,
                    other: Number(e.other) || 0,
                    itemPhotoUrl: e.itemPhotoUrl || '',
                    masterCategoryId: e.masterCategoryId,
                    masterCategoryName: e.masterCategoryName,
                    sheetName: e.masterSheetName || e.sheetName
                });
            });
            state.receipts = Object.values(map).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            updateDashboardSubCategoryOptions();
            updateDashboardMerchantOptions();
            if (typeof enhanceAllCustomSelects === 'function') {
                enhanceAllCustomSelects();
            }
        }

        /* ---------------- UTILITY: TOAST & ESCAPE (DYNAMIC ISLAND - THEMED) ---------------- */
        function showToast(message, type = 'info', duration = 3500) {
            const container = document.getElementById('toastContainer');
            if (!container) return;

            // Batasi maksimal 2 notifikasi aktif di bar atas agar rapi layaknya Dynamic Island
            while (container.children.length >= 2) {
                if (container.firstElementChild) {
                    dismissDynamicIsland(container.firstElementChild);
                    break;
                }
            }

            const toast = document.createElement('div');
            toast.className = "dynamic-island-notification group pointer-events-auto flex items-center justify-between gap-3 px-4 py-2 rounded-full border shadow-lg backdrop-blur-md transition-all duration-300 text-xs font-semibold";

            let iconHtml = '<i class="fa-solid fa-circle-info text-[var(--primary)] text-sm shrink-0"></i>';
            let colorClasses = "bg-[var(--bg-surface)] text-[var(--text-main)] border-[var(--border-color)]";

            if (type === 'success') {
                iconHtml = '<i class="fa-solid fa-circle-check text-emerald-500 text-sm shrink-0"></i>';
                colorClasses = "bg-[var(--bg-surface)] text-[var(--text-main)] border-emerald-500/40 shadow-emerald-500/10";
            } else if (type === 'error') {
                iconHtml = '<i class="fa-solid fa-circle-exclamation text-rose-500 text-sm shrink-0"></i>';
                colorClasses = "bg-[var(--bg-surface)] text-[var(--text-main)] border-rose-500/40 shadow-rose-500/10";
            } else if (type === 'warning') {
                iconHtml = '<i class="fa-solid fa-triangle-exclamation text-amber-500 text-sm shrink-0"></i>';
                colorClasses = "bg-[var(--bg-surface)] text-[var(--text-main)] border-amber-500/40 shadow-amber-500/10";
            }

            toast.className += " " + colorClasses;
            toast.setAttribute('role', 'alert');
            toast.setAttribute('aria-live', 'polite');
            toast.innerHTML = `
                <div class="flex items-center gap-2.5 min-w-0">
                    ${iconHtml}
                    <span class="truncate max-w-[240px] sm:max-w-xs md:max-w-sm text-xs font-semibold tracking-tight text-[var(--text-main)] select-none leading-tight">${escapeHtml(message)}</span>
                </div>
                <button type="button" class="text-[var(--text-muted)] hover:text-[var(--text-main)] text-xs ml-1 p-0.5 rounded-full transition-colors flex items-center justify-center shrink-0" onclick="event.stopPropagation(); dismissDynamicIsland(this.closest('.dynamic-island-notification'))" title="Tutup">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            `;

            toast.onclick = function() {
                dismissDynamicIsland(toast);
            };

            container.appendChild(toast);

            const timer = setTimeout(() => {
                dismissDynamicIsland(toast);
            }, duration);
            toast._dismissTimer = timer;
        }

        function dismissDynamicIsland(el) {
            if (!el || el._isDismissing) return;
            el._isDismissing = true;
            if (el._dismissTimer) clearTimeout(el._dismissTimer);
            el.classList.add('dynamic-island-exit');
            setTimeout(() => {
                if (el.parentElement) el.remove();
            }, 280);
        }

        function escapeHtml(str) {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        /* ========================================================
           THEMED ALERT & CONFIRM DIALOG SYSTEM (OVERRIDE NATIVE)
           Mengganti native browser alert() & confirm() agar 100%
           mengikuti tema aplikasi (Light/Dark/Brutalism + Aksen Warna).
           ======================================================== */
        let themedDialogResolver = null;

        function ensureThemedDialogElement() {
            let modal = document.getElementById('themedDialogModal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'themedDialogModal';
                modal.className = "fixed inset-0 z-[10060] bg-black/75 backdrop-blur-sm hidden items-center justify-center p-4 transition-all opacity-0 duration-200";
                modal.setAttribute('onclick', 'if(event.target === this) closeThemedDialog(false)');
                modal.innerHTML = `
                    <div class="modal-box bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-3xl max-w-sm w-full p-6 text-center space-y-4 shadow-2xl relative overflow-hidden transform scale-95 transition-all duration-200">
                        <div id="themedDialogGlow" class="absolute -top-10 -right-10 w-28 h-28 bg-[var(--primary)]/15 rounded-full blur-xl pointer-events-none transition-colors"></div>
                        <div class="absolute -bottom-10 -left-10 w-24 h-24 bg-amber-500/10 rounded-full blur-xl pointer-events-none"></div>

                        <div id="themedDialogIconWrapper" class="w-14 h-14 mx-auto rounded-2xl bg-[var(--primary-light)] text-[var(--primary)] flex items-center justify-center text-2xl border border-[var(--primary)]/20 shadow-sm transition-colors">
                            <i id="themedDialogIcon" class="fa-solid fa-circle-info"></i>
                        </div>

                        <div class="space-y-2">
                            <h3 id="themedDialogTitle" class="text-base font-bold text-slate-900 dark:text-white leading-tight">Pemberitahuan</h3>
                            <div id="themedDialogMessage" class="text-xs text-slate-500 dark:text-slate-400 font-normal leading-relaxed text-center whitespace-pre-line"></div>
                        </div>

                        <div id="themedDialogActions" class="flex justify-center pt-2">
                            <button type="button" id="themedDialogCancelBtn" onclick="closeThemedDialog(false)" class="btn-secondary text-xs py-2.5 px-4 rounded-xl font-semibold transition-all hidden">
                                Batal
                            </button>
                            <button type="button" id="themedDialogConfirmBtn" onclick="closeThemedDialog(true)" class="btn-primary text-xs py-2.5 px-4 rounded-xl font-bold flex items-center justify-center gap-1.5 shadow-md transition-all w-full">
                                <span>Mengerti</span>
                            </button>
                        </div>
                    </div>
                `;
                document.body.appendChild(modal);
            }
            return modal;
        }

        function showThemedDialog(options = {}) {
            return new Promise((resolve) => {
                themedDialogResolver = resolve;
                const modal = ensureThemedDialogElement();

                const titleEl = document.getElementById('themedDialogTitle');
                const msgEl = document.getElementById('themedDialogMessage');
                const iconEl = document.getElementById('themedDialogIcon');
                const iconWrapper = document.getElementById('themedDialogIconWrapper');
                const glowEl = document.getElementById('themedDialogGlow');
                const cancelBtn = document.getElementById('themedDialogCancelBtn');
                const confirmBtn = document.getElementById('themedDialogConfirmBtn');
                const actionsContainer = document.getElementById('themedDialogActions');

                const isConfirm = options.isConfirm === true;
                const type = options.type || 'info'; // 'info', 'success', 'warning', 'danger' / 'error'
                const title = options.title || (isConfirm ? 'Konfirmasi' : 'Pemberitahuan');
                const message = typeof options === 'string' ? options : (options.message || '');
                const confirmText = options.confirmText || (isConfirm ? 'Ya, Lanjutkan' : 'Mengerti');
                const cancelText = options.cancelText || 'Batal';

                if (titleEl) titleEl.textContent = title;
                if (msgEl) {
                    if (options.isHtml) {
                        msgEl.innerHTML = message;
                    } else {
                        msgEl.textContent = message;
                    }
                }

                if (iconWrapper && iconEl && glowEl) {
                    iconWrapper.className = "w-14 h-14 mx-auto rounded-2xl flex items-center justify-center text-2xl border shadow-sm transition-colors";
                    if (type === 'danger' || type === 'error') {
                        iconWrapper.classList.add('bg-rose-500/10', 'dark:bg-rose-500/20', 'text-rose-500', 'border-rose-500/20');
                        iconEl.className = "fa-solid fa-triangle-exclamation";
                        glowEl.className = "absolute -top-10 -right-10 w-28 h-28 bg-rose-500/15 rounded-full blur-xl pointer-events-none transition-colors";
                        if (confirmBtn) {
                            confirmBtn.className = "btn-primary !bg-rose-600 hover:!bg-rose-700 !text-white text-xs py-2.5 px-4 rounded-xl font-bold flex items-center justify-center gap-1.5 shadow-md shadow-rose-600/20 transition-all";
                        }
                    } else if (type === 'warning') {
                        iconWrapper.classList.add('bg-amber-500/10', 'dark:bg-amber-500/20', 'text-amber-500', 'border-amber-500/20');
                        iconEl.className = "fa-solid fa-triangle-exclamation";
                        glowEl.className = "absolute -top-10 -right-10 w-28 h-28 bg-amber-500/15 rounded-full blur-xl pointer-events-none transition-colors";
                        if (confirmBtn) {
                            confirmBtn.className = "btn-primary !bg-amber-500 hover:!bg-amber-600 !text-white text-xs py-2.5 px-4 rounded-xl font-bold flex items-center justify-center gap-1.5 shadow-md shadow-amber-500/20 transition-all";
                        }
                    } else if (type === 'success') {
                        iconWrapper.classList.add('bg-emerald-500/10', 'dark:bg-emerald-500/20', 'text-emerald-500', 'border-emerald-500/20');
                        iconEl.className = "fa-solid fa-circle-check";
                        glowEl.className = "absolute -top-10 -right-10 w-28 h-28 bg-emerald-500/15 rounded-full blur-xl pointer-events-none transition-colors";
                        if (confirmBtn) {
                            confirmBtn.className = "btn-primary text-xs py-2.5 px-4 rounded-xl font-bold flex items-center justify-center gap-1.5 shadow-md transition-all";
                        }
                    } else {
                        // info / default
                        iconWrapper.classList.add('bg-[var(--primary-light)]', 'text-[var(--primary)]', 'border-[var(--primary)]/20');
                        iconEl.className = "fa-solid fa-circle-info";
                        glowEl.className = "absolute -top-10 -right-10 w-28 h-28 bg-[var(--primary)]/15 rounded-full blur-xl pointer-events-none transition-colors";
                        if (confirmBtn) {
                            confirmBtn.className = "btn-primary text-xs py-2.5 px-4 rounded-xl font-bold flex items-center justify-center gap-1.5 shadow-md transition-all";
                        }
                    }
                }

                if (confirmBtn) {
                    confirmBtn.innerHTML = `<span>${escapeHtml(confirmText)}</span>`;
                }

                if (cancelBtn) {
                    cancelBtn.textContent = cancelText;
                    if (isConfirm) {
                        cancelBtn.classList.remove('hidden');
                        if (actionsContainer) {
                            actionsContainer.className = "grid grid-cols-2 gap-2 pt-2";
                        }
                        if (confirmBtn) {
                            confirmBtn.classList.remove('w-full');
                        }
                    } else {
                        cancelBtn.classList.add('hidden');
                        if (actionsContainer) {
                            actionsContainer.className = "flex justify-center pt-2";
                        }
                        if (confirmBtn) {
                            confirmBtn.classList.add('w-full');
                        }
                    }
                }

                modal.classList.remove('hidden');
                modal.classList.add('flex');
                requestAnimationFrame(() => {
                    modal.classList.remove('opacity-0');
                    const box = modal.querySelector('.modal-box');
                    if (box) {
                        box.classList.remove('scale-95');
                        box.classList.add('scale-100');
                    }
                });

                if (confirmBtn) {
                    setTimeout(() => confirmBtn.focus(), 60);
                }
            });
        }

        function closeThemedDialog(result = false) {
            const modal = document.getElementById('themedDialogModal');
            if (modal) {
                modal.classList.add('opacity-0');
                const box = modal.querySelector('.modal-box');
                if (box) {
                    box.classList.remove('scale-100');
                    box.classList.add('scale-95');
                }
                setTimeout(() => {
                    modal.classList.add('hidden');
                    modal.classList.remove('flex');
                    if (typeof themedDialogResolver === 'function') {
                        themedDialogResolver(result);
                        themedDialogResolver = null;
                    }
                }, 180);
            } else {
                if (typeof themedDialogResolver === 'function') {
                    themedDialogResolver(result);
                    themedDialogResolver = null;
                }
            }
        }

        function customAlert(message, options = {}) {
            if (typeof options === 'string') {
                options = { title: options };
            }
            return showThemedDialog({
                message: message,
                title: options.title || 'Pemberitahuan',
                type: options.type || 'info',
                confirmText: options.confirmText || 'Mengerti',
                isConfirm: false,
                isHtml: options.isHtml || false
            });
        }

        function customConfirm(message, options = {}) {
            if (typeof options === 'string') {
                options = { title: options };
            }
            return showThemedDialog({
                message: message,
                title: options.title || 'Konfirmasi',
                type: options.type || 'warning',
                confirmText: options.confirmText || 'Ya, Lanjutkan',
                cancelText: options.cancelText || 'Batal',
                isConfirm: true,
                isHtml: options.isHtml || false
            });
        }

        // Global override: Mencegah browser native alert muncul dan menggantinya dengan Themed Modal
        window.alert = function(message) {
            return customAlert(message);
        };
        window.customAlert = customAlert;
        window.customConfirm = customConfirm;

        // Listener Enter / Escape untuk Themed Dialog
        window.addEventListener('keydown', function(e) {
            const modal = document.getElementById('themedDialogModal');
            if (modal && !modal.classList.contains('hidden') && !modal.classList.contains('opacity-0')) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    closeThemedDialog(true);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeThemedDialog(false);
                }
            }
        });

        /* ========================================================
           CUSTOM DROPDOWN COMPONENT CONTROLLER (ROUNDED, BUKAN KOTAK)
           Mengubah <select class="custom-select"> menjadi komponen UI modern
           dengan kontainer rounded 12px dan item-item rounded 8px.
           ======================================================== */
        function enhanceAllCustomSelects() {
            const selects = document.querySelectorAll('select.custom-select');
            selects.forEach(enhanceSingleCustomSelect);
        }

        function enhanceSingleCustomSelect(selectEl) {
            if (!selectEl) return;
            if (selectEl.dataset.customDropdownReady === 'true') {
                refreshCustomDropdown(selectEl);
                return;
            }

            // Sembunyikan select native agar browser tidak membuka popup kotak OS
            selectEl.style.display = 'none';

            // Kontainer kustom
            const container = document.createElement('div');
            container.className = 'custom-dropdown-container';
            
            // Ambil kelas pembungkus jika select memiliki w-full atau flex-1
            if (selectEl.classList.contains('w-full')) container.classList.add('w-full');
            if (selectEl.classList.contains('flex-1')) container.classList.add('flex-1');
            if (selectEl.id) container.dataset.forSelect = selectEl.id;

            // Tombol Trigger (Rounded 10px, Soft Shadow)
            const trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.className = 'custom-dropdown-trigger';
            if (selectEl.title) trigger.title = selectEl.title;

            const labelSpan = document.createElement('span');
            labelSpan.className = 'custom-dropdown-label truncate flex-1 text-left mr-2';

            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-chevron-down text-[10px] shrink-0 text-[var(--text-muted)] transition-transform duration-200';

            trigger.appendChild(labelSpan);
            trigger.appendChild(icon);

            // Menu Popover Options (Bukan Kotak Kaku: Rounded 12px, Soft Floating Shadow, Samar Border)
            const optionsMenu = document.createElement('div');
            optionsMenu.className = 'custom-dropdown-options hidden';

            container.appendChild(trigger);
            container.appendChild(optionsMenu);

            selectEl.parentNode.insertBefore(container, selectEl.nextSibling);
            selectEl.dataset.customDropdownReady = 'true';
            selectEl._customDropdownContainer = container;

            // Klik trigger untuk toggle buka/tutup
            trigger.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const isCurrentlyOpen = !optionsMenu.classList.contains('hidden');
                closeAllCustomDropdowns();
                if (!isCurrentlyOpen) {
                    refreshCustomDropdown(selectEl);
                    positionDropdownMenu(trigger, optionsMenu);
                    optionsMenu.classList.remove('hidden');
                    trigger.classList.add('open');
                    container.classList.add('is-open');

                    // Elevasikan seluruh rantai elemen induk agar dropdown tidak tertutup card / baris di bawahnya
                    let p = container.parentElement;
                    while (p && p !== document.body && !p.classList.contains('main-content') && !p.classList.contains('app-layout') && !p.id.startsWith('view-') && !p.classList.contains('fixed') && !p.id.endsWith('Modal')) {
                        if (!p.classList.contains('modal-box')) {
                            p.classList.add('dropdown-open-parent');
                        }
                        p = p.parentElement;
                    }
                }
            });

            // Isi opsi kustom pertama kali
            refreshCustomDropdown(selectEl);

            // Sinkronkan saat native select berubah dari JS
            selectEl.addEventListener('change', function() {
                updateCustomDropdownSelectedLabel(selectEl);
            });

            // Pantau perubahan dinamis opsi (misal saat innerHTML diubah oleh updateCategoryDropdowns)
            const observer = new MutationObserver(function() {
                refreshCustomDropdown(selectEl);
            });
            observer.observe(selectEl, { childList: true, subtree: true });
        }

        function refreshCustomDropdown(selectEl) {
            if (!selectEl || !selectEl._customDropdownContainer) return;
            const container = selectEl._customDropdownContainer;
            const trigger = container.querySelector('.custom-dropdown-trigger');
            const labelSpan = container.querySelector('.custom-dropdown-label');
            const optionsMenu = container.querySelector('.custom-dropdown-options');
            if (!optionsMenu) return;

            optionsMenu.innerHTML = '';
            const selectedOption = selectEl.options[selectEl.selectedIndex] || selectEl.options[0];
            if (labelSpan) {
                labelSpan.textContent = selectedOption ? selectedOption.textContent : (selectEl.placeholder || 'Pilih...');
            }

            Array.from(selectEl.options).forEach((opt, idx) => {
                const item = document.createElement('div');
                item.className = 'custom-dropdown-option';
                if (opt.selected || opt.value === selectEl.value) {
                    item.classList.add('selected');
                }

                const textSpan = document.createElement('span');
                textSpan.className = 'truncate flex-1';
                textSpan.textContent = opt.textContent;

                const checkIcon = document.createElement('i');
                checkIcon.className = 'fa-solid fa-check check-icon text-xs';

                item.appendChild(textSpan);
                item.appendChild(checkIcon);

                item.addEventListener('click', function(e) {
                    e.stopPropagation();
                    selectEl.value = opt.value;
                    selectEl.selectedIndex = idx;

                    // Trigger event onchange asli
                    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                    selectEl.dispatchEvent(new Event('input', { bubbles: true }));
                    if (typeof selectEl.onchange === 'function') {
                        selectEl.onchange.call(selectEl);
                    }

                    updateCustomDropdownSelectedLabel(selectEl);
                    closeAllCustomDropdowns();
                });

                optionsMenu.appendChild(item);
            });
        }

        function updateCustomDropdownSelectedLabel(selectEl) {
            if (!selectEl || !selectEl._customDropdownContainer) return;
            const container = selectEl._customDropdownContainer;
            const labelSpan = container.querySelector('.custom-dropdown-label');
            const optionsMenu = container.querySelector('.custom-dropdown-options');
            const selectedOption = selectEl.options[selectEl.selectedIndex];
            if (labelSpan && selectedOption) {
                labelSpan.textContent = selectedOption.textContent;
            }
            if (optionsMenu) {
                Array.from(optionsMenu.children).forEach((child, idx) => {
                    const opt = selectEl.options[idx];
                    if (opt && (opt.selected || opt.value === selectEl.value)) {
                        child.classList.add('selected');
                    } else {
                        child.classList.remove('selected');
                    }
                });
            }
        }

        function positionDropdownMenu(trigger, optionsMenu) {
            const rect = trigger.getBoundingClientRect();
            const bottomNavHeight = (window.innerWidth <= 1024) ? 74 : 0;
            const spaceBelow = window.innerHeight - rect.bottom - bottomNavHeight;
            const spaceAbove = rect.top;
            const menuHeight = 220;

            // Periksa sisa ruang di dalam scroll container terdekat (seperti modal)
            let scrollParent = trigger.parentElement;
            let spaceInParent = spaceBelow;
            while (scrollParent && scrollParent !== document.body) {
                const style = window.getComputedStyle(scrollParent);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    const parentRect = scrollParent.getBoundingClientRect();
                    spaceInParent = parentRect.bottom - rect.bottom - bottomNavHeight;
                    break;
                }
                scrollParent = scrollParent.parentElement;
            }

            if ((spaceBelow < menuHeight && spaceAbove > spaceBelow) || (spaceInParent < 150 && spaceAbove > 180)) {
                optionsMenu.classList.add('open-up');
            } else {
                optionsMenu.classList.remove('open-up');
            }
        }

        function closeAllCustomDropdowns() {
            document.querySelectorAll('.custom-dropdown-options:not(.hidden)').forEach(m => m.classList.add('hidden'));
            document.querySelectorAll('.custom-dropdown-trigger.open').forEach(t => t.classList.remove('open'));
            document.querySelectorAll('.custom-dropdown-container.is-open').forEach(c => c.classList.remove('is-open'));
            document.querySelectorAll('.dropdown-open-parent').forEach(p => p.classList.remove('dropdown-open-parent'));
        }

        // Tutup saat window di-resize
        window.addEventListener('resize', closeAllCustomDropdowns);

        // Tutup saat klik di luar
        document.addEventListener('click', function(e) {
            if (!e.target.closest('.custom-dropdown-container')) {
                closeAllCustomDropdowns();
            }
        });

        // Tutup dengan tombol Escape
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                closeAllCustomDropdowns();
            }
        });

        /* ========================================================
           DATE & TIME INPUT INTERACTION ENHANCEMENT
           Mengklik di mana saja pada kotak input tanggal/waktu (formDate,
           remInputDueDate, dll.) langsung membuka calendar picker tanpa
           harus menekan icon kalender kecil secara spesifik.
           ======================================================== */
        document.addEventListener('click', function(e) {
            const target = e.target;
            if (target && target.tagName === 'INPUT' && (target.type === 'date' || target.type === 'time' || target.type === 'datetime-local' || target.type === 'month')) {
                if (!target.disabled && !target.readOnly && typeof target.showPicker === 'function') {
                    try {
                        target.showPicker();
                    } catch (err) {
                        // Diabaikan jika browser membatasi atau picker sudah terbuka
                    }
                }
            }
        });

        /* ========================================================
           10. INITIALIZATION
           ======================================================== */
        document.addEventListener('DOMContentLoaded', function() {
            // Restore theme (Default: Light Mode) & update UI sync
            const savedTheme = safeStorage.getItem('saturuma_theme') || 'light';
            setTheme(savedTheme, true);

            // Restore card border style (Default: Border Kategori) & update UI sync
            const savedCardBorder = safeStorage.getItem('saturuma_card_border') || 'category-accent';
            setCardBorderStyle(savedCardBorder, true);

            // Inisialisasi Custom Dropdowns (Rounded, Bukan Kotak)
            enhanceAllCustomSelects();

            // Auto-enhance setiap select baru di DOM
            const bodySelectObserver = new MutationObserver(function() {
                const unenhanced = document.querySelectorAll('select.custom-select:not([data-custom-dropdown-ready="true"])');
                if (unenhanced.length > 0) {
                    unenhanced.forEach(enhanceSingleCustomSelect);
                }
            });
            bodySelectObserver.observe(document.body, { childList: true, subtree: true });

            // Restore saved master categories if any
            const savedCats = safeStorage.getItem('saturuma_categories');
            if (savedCats) {
                try {
                    const parsed = JSON.parse(savedCats);
                    if (Array.isArray(parsed) && parsed.length > 0) state.masterCategories = parsed;
                } catch(e) {}
            }

            // Restore reminders
            const savedRems = safeStorage.getItem('saturuma_reminders');
            if (savedRems) {
                try { state.reminders = JSON.parse(savedRems); } catch(e) {}
            }

            // Inisialisasi contoh pengingat aktif jika belum ada agar notifikasi terlihat
            if (!state.reminders || state.reminders.length === 0) {
                state.reminders = [
                    { id: "REM-1", title: "Beli Beras & Minyak Goreng", categoryId: "dapur", date: new Date().toISOString().split('T')[0], estCost: 75000, completed: false },
                    { id: "REM-2", title: "Restok Popok Bayi Ukuran M", categoryId: "bayi", date: new Date().toISOString().split('T')[0], estCost: 89000, completed: false },
                    { id: "REM-3", title: "Bayar Tagihan Listrik Bulanan", categoryId: "dapur", date: new Date().toISOString().split('T')[0], estCost: 350000, completed: false }
                ];
            }
            updateAllNotificationBadges();

            // Restore deskripsi & katalog barang (stockItems)
            const savedStock = safeStorage.getItem('saturuma_stock_items');
            if (savedStock) {
                try {
                    const parsed = JSON.parse(savedStock);
                    if (Array.isArray(parsed) && parsed.length > 0) state.stockItems = parsed;
                } catch(e) {}
            }

            // Inisialisasi contoh item katalog jika masih kosong
            if (!state.stockItems || state.stockItems.length === 0) {
                state.stockItems = [
                    {
                        id: "STK-1",
                        name: "Beras Ramos Pandan Wangi 5kg",
                        categoryId: "dapur",
                        location: "Lemari Dapur Bawah",
                        description: "Beras pulen kemasan karung hijau transparan, merk Ramos kemasan 5kg. Pastikan pilih yang wangi pandan alami.",
                        estCost: 74500,
                        unit: "Karung 5kg",
                        photoUrl: ""
                    },
                    {
                        id: "STK-2",
                        name: "Minyak Goreng Refill 2 Liter",
                        categoryId: "dapur",
                        location: "Rak Dapur",
                        description: "Minyak goreng kelapa sawit kemasan pouch refill 2L (Bimoli / Tropical / Sania).",
                        estCost: 37500,
                        unit: "Pouch 2L",
                        photoUrl: ""
                    },
                    {
                        id: "STK-3",
                        name: "Sabun Cuci Piring Jeruk Nipis 780ml",
                        categoryId: "dapur",
                        location: "Bawah Wastafel",
                        description: "Sunlight varian Jeruk Nipis kemasan pouch refill 780ml pembersih lemak ampuh.",
                        estCost: 15800,
                        unit: "Pouch 780ml",
                        photoUrl: ""
                    }
                ];
                safeStorage.setItem('saturuma_stock_items', JSON.stringify(state.stockItems));
            }

            // Restore batas anggaran per modul kategori
            const savedCategoryBudgets = safeStorage.getItem('saturuma_category_budgets');
            if (savedCategoryBudgets) {
                try {
                    state.categoryBudgets = JSON.parse(savedCategoryBudgets) || {};
                } catch(e) {}
            }

            // Init Accent Color (Mengikuti warna Semua Modul yang dikonfigurasi)
            const mcInit = getMultiModuleConfig();
            applyDynamicAccentColor(mcInit.color || '#10B981');

            // Setup UI Components
            updateCategoryDropdowns();
            renderCategoryPills();
            renderSidebarCategories();
            resetTransactionForm();
            switchScannerMethod('full_ai');

            // Default landing: Dashboard view!
            setAppMode('dashboard');

            // Periksa Sesi Otentikasi Login (Aman & Otomatis)
            checkUserSession();

            // Setup Drag & Drop untuk Scanner Struk
            const dropArea = document.getElementById('dropArea');
            const fileInput = document.getElementById('receiptFileInput');
            if (dropArea && fileInput) {
                dropArea.addEventListener('click', () => fileInput.click());
                dropArea.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    dropArea.classList.add('border-purple-500', 'bg-purple-50/20');
                });
                dropArea.addEventListener('dragleave', () => {
                    dropArea.classList.remove('border-purple-500', 'bg-purple-50/20');
                });
                dropArea.addEventListener('drop', (e) => {
                    e.preventDefault();
                    dropArea.classList.remove('border-purple-500', 'bg-purple-50/20');
                    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                        handleFileSelected(e.dataTransfer.files[0]);
                    }
                });
            }

            // Close modal with Escape key
            window.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') {
                    closeMasterCategoryModal();
                    closePhotoPreviewModal();
                    closeAddReminderModal();
                    closeItemCatalogModal();
                    closeDeleteConfirmModal();
                    closeDeleteCategoryModal();
                    closeLogoutConfirmModal();
                    closeThemedDialog(false);
                    closeIosGuideModal();
                    closeAndroidGuideModal();
                    closeMobileSidebar();
                    closeNotificationDropdown();
                }
            });

            // Pada tampilan tablet / handphone: otomatis sembunyikan sidebar atau dropdown saat mengeklik di luar elemen
            document.addEventListener('click', function(e) {
                const sidebar = document.getElementById('appSidebar');
                if (sidebar && sidebar.classList.contains('mobile-open')) {
                    const isInsideSidebar = e.target.closest('#appSidebar');
                    const isToggleBtn = e.target.closest('button[onclick*="toggleMobileSidebar"]');
                    if (!isInsideSidebar && !isToggleBtn) {
                        closeMobileSidebar();
                    }
                }

                // Tutup dropdown notifikasi saat klik di luar area
                const notifDropdown = document.getElementById('notificationDropdown');
                if (notifDropdown && !notifDropdown.classList.contains('hidden')) {
                    const isInsideDropdown = e.target.closest('#notificationDropdown');
                    const isNotifBtn = e.target.closest('#topBarNotificationBtn');
                    if (!isInsideDropdown && !isNotifBtn) {
                        closeNotificationDropdown();
                    }
                }
            });
        });

        // ==========================================
        // PWA & SERVICE WORKER LOGIC
        // ==========================================
        let deferredPwaPrompt = null;
        const isPwaInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

        // 1. Registrasi Service Worker
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw.js')
                    .then((reg) => {
                        console.log('[PWA] Service Worker terdaftar dengan scope:', reg.scope);
                    })
                    .catch((err) => {
                        console.warn('[PWA] Gagal mendaftarkan Service Worker:', err);
                    });
            });
        }

        // 2. Tangkap event install prompt browser (Android Chrome, Edge)
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPwaPrompt = e;
            
            // Tampilkan floating banner jika belum terpasang dan belum pernah ditutup sesi ini
            if (!isPwaInstalled && !sessionStorage.getItem('pwa_banner_dismissed')) {
                const banner = document.getElementById('pwaMobileInstallBanner');
                if (banner) banner.classList.remove('hidden');
            }
        });

        // 3. Listener saat aplikasi berhasil dipasang
        window.addEventListener('appinstalled', () => {
            deferredPwaPrompt = null;
            const banner = document.getElementById('pwaMobileInstallBanner');
            if (banner) banner.classList.add('hidden');
            const sidebarWrapper = document.getElementById('sidebarInstallPwaWrapper');
            if (sidebarWrapper) sidebarWrapper.classList.add('hidden');
            console.log('[PWA] Saturuma berhasil dipasang ke Layar Utama!');
        });

        function isIosDevice() {
            return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        }

        function triggerPwaInstall() {
            if (deferredPwaPrompt) {
                deferredPwaPrompt.prompt();
                deferredPwaPrompt.userChoice.then((choiceResult) => {
                    if (choiceResult.outcome === 'accepted') {
                        const banner = document.getElementById('pwaMobileInstallBanner');
                        if (banner) banner.classList.add('hidden');
                    }
                    deferredPwaPrompt = null;
                });
            } else if (isIosDevice()) {
                openIosGuideModal();
            } else {
                openAndroidGuideModal();
            }
        }

        function dismissPwaBanner() {
            sessionStorage.setItem('pwa_banner_dismissed', 'true');
            const banner = document.getElementById('pwaMobileInstallBanner');
            if (banner) banner.classList.add('hidden');
        }

        function openIosGuideModal() {
            const modal = document.getElementById('pwaIosGuideModal');
            if (modal) modal.classList.remove('hidden');
        }

        function closeIosGuideModal() {
            const modal = document.getElementById('pwaIosGuideModal');
            if (modal) modal.classList.add('hidden');
        }

        function openAndroidGuideModal() {
            const modal = document.getElementById('pwaAndroidGuideModal');
            if (modal) {
                modal.classList.remove('hidden');
            } else {
                customAlert('Untuk menambahkan ke Layar Utama:\n1. Buka menu titik tiga (⋮) di browser HP Anda.\n2. Pilih "Tambahkan ke Layar Utama" (Add to Home screen / Install app).', {
                    title: 'Tambahkan ke Layar Utama',
                    type: 'info',
                    confirmText: 'Saya Mengerti'
                });
            }
        }

        function closeAndroidGuideModal() {
            const modal = document.getElementById('pwaAndroidGuideModal');
            if (modal) modal.classList.add('hidden');
        }

        // Tampilkan banner di iOS Safari jika belum terpasang
        document.addEventListener('DOMContentLoaded', () => {
            if (isPwaInstalled) {
                const sidebarWrapper = document.getElementById('sidebarInstallPwaWrapper');
                if (sidebarWrapper) sidebarWrapper.classList.add('hidden');
            } else if (isIosDevice() && !sessionStorage.getItem('pwa_banner_dismissed')) {
                const banner = document.getElementById('pwaMobileInstallBanner');
                if (banner) banner.classList.remove('hidden');
            }
        });
