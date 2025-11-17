      const GAS_API_URL = "https://script.google.com/a/macros/ana.co.jp/s/AKfycbxQ7l90Qg1vanpbrK3GXR1eaaEpuuYbzQidnkb0T1lNh_ujsQbDq84UrQ9mYeCzo_bx/exec";
      const REPO_PATH = '/manual-search'; // (例: '/my-search-app')

      
      const dbPromise = idb.openDB('data-cache-db', 10, {
        upgrade(db, oldVersion, newVersion, transaction) {
          console.log(`Upgrading DB from v${oldVersion} to v${newVersion}`);
          
          if (oldVersion < 10) {
            console.log("Rebuilding database for v10...");
            
            const storeNames = Array.from(db.objectStoreNames);
            storeNames.forEach(storeName => {
              db.deleteObjectStore(storeName);
              console.log(`Removed old store: ${storeName}`);
            });

            db.createObjectStore('keyval');
            console.log("Created 'keyval' store.");
            
            const fileStore = db.createObjectStore('files', { keyPath: 'id' });
            fileStore.createIndex('byPath', 'path');
            fileStore.createIndex('byFolderId', 'folderId');
            console.log("Created 'files' store with 'id' keyPath and indexes.");
            
            db.createObjectStore('thumbnail-cache');
            console.log("Created 'thumbnail-cache' store.");

          }
        },
      });
      
      const AppState = {
        allFilesData: [], 
        allSearchResults: [], 
        currentFilteredResults: [],
        thumbnailCache: {}, 
        dimensionsCache: new Map(), // (★) この行を追加
        currentModalIndex: -1, 
        currentSearchKeywords: [], 
        folderSortOrderMap: new Map(), 
        currentPage: 1, 

        downloadManager: {
          idsToFetch: new Set(), // (★) すべてのダウンロード要求をここで一元管理
          inFlightRequests: 0,   // (★) 現在実行中のリクエスト数
          // フォルダプリロード専用の状態
          preloadingFolder: null, // プリロード中のフォルダ名
          preloadTotal: 0,        // プリロード対象の総数
          preloadFetched: 0,      // プリロード済みの数
          preloadToast: null      // 表示中のトースト
        },
        
        // (★) 追加: 読書モードの状態
        isReadingMode: false,
        currentFileId: null, // モーダルで開いている基準FileId
        currentFolderName: null, // モーダルで開いている基準Folder
        currentFileName: null, // モーダルで開いている基準File名
        
        // インスタンスやタイマー
        imageModalInstance: null,
        modalElement: null,
        thumbnailObserver: null,
        preloadCacheButton: null,
        thumbnailsToFetch: new Set(),
        fetchTimer: null,
        searchTimer: null,
        cacheLoadTimer: null,
        simulationTimer: null,
        offlineToastInstance: null,
        
        // DOM要素 (読み込み時)
        loadingProgressBar: null,
        cacheLoadingText: null,
        
        // 状態 (読み込み時)
        currentProgress: 0,
        targetProgress: 0,
      };

      // グローバル定数
      const PRELOAD_CHUNK_SIZE = 10;
      const PRELOAD_MAX_CONCURRENCY = 3;
      const RECENT_SEARCH_KEY = 'recentSearches';
      const MAX_RECENT_SEARCHES = 10;
      const ITEMS_PER_PAGE =50;

      // ヘルパー関数群
      function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      function escapeAndHighlight(text, keywords) {
          if (!text) return "";
          const escapedText = text.replace(/[&<>"']/g, function(m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x39;' }[m];
          });
          if (keywords && keywords.length > 0) {
            const highlightRegex = new RegExp(
                keywords.map(k => escapeRegExp(k)).join('|'), 'gi'
            );
            return escapedText.replace(highlightRegex, '<strong>$&</strong>');
          }
          return escapedText;
      }

      function handleFolderClick(event, item) {
        event.stopPropagation();
        if (event.target.tagName === 'A' || event.target.closest('A')) {
          return;
        }
        if (event.target.type === 'checkbox' || event.target.tagName === 'LABEL' || event.target.tagName === 'STRONG') {
          return;
        }
        const checkbox = item.querySelector('input[type="checkbox"]');
        if (!checkbox) return;
        checkbox.checked = !checkbox.checked;
        if (checkbox.id === 'checkAllFolders') {
            toggleAllCheckboxes(checkbox.checked);
        } else {
            handleCheckboxChange(checkbox);
        }
      }

      function handleFolderDoubleClick(event, item) {
        event.stopPropagation();
        const clickedCheckbox = item.querySelector('input[type="checkbox"]');
        if (!clickedCheckbox) return;

        if (clickedCheckbox.id === 'checkAllFolders') {
            toggleAllCheckboxes(true);
            return;
        }

        let topLevelItem = item;
        let parentContainer = item.parentElement;
        while (parentContainer && parentContainer.id !== 'folderList') {
          if (parentContainer.classList.contains('nested-list-group')) {
            topLevelItem = parentContainer.previousElementSibling;
            parentContainer = topLevelItem.parentElement;
          } else {
            break;
          }
        }
        const allTopLevelCheckboxes = [];
        document.getElementById('folderList').childNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('list-group-item')) {
                const cb = node.querySelector('input[type="checkbox"]');
                if (cb && cb.id !== 'checkAllFolders') {
                    allTopLevelCheckboxes.push(cb);
                }
            }
        });

        let otherTopLevelItemsChecked = false;
        allTopLevelCheckboxes.forEach(cb => {
          const topLevelItemOfCb = cb.closest('.list-group-item');
          if (topLevelItemOfCb === topLevelItem) return;
          if (cb.checked || cb.indeterminate) {
            otherTopLevelItemsChecked = true;
          }
        });

        const thisBranchCheckbox = topLevelItem.querySelector('input[type="checkbox"]');
        const isThisBranchChecked = thisBranchCheckbox.checked || thisBranchCheckbox.indeterminate;
        const isOnlyThisBranchChecked = isThisBranchChecked && !otherTopLevelItemsChecked;

        if (isOnlyThisBranchChecked) {
          toggleAllCheckboxes(true);
        } else {
          document.querySelectorAll('#folderList input[type="checkbox"]').forEach(cb => {
              cb.checked = false;
              cb.indeterminate = false;
          });
          clickedCheckbox.checked = true;
          handleCheckboxChange(clickedCheckbox);
        }
      }

      function handleModalKeydown(e) {
        if (!AppState.imageModalInstance || !AppState.imageModalInstance._isShown) return;

        const pageInput = document.getElementById('modalPageInput');
        const activeElement = document.activeElement;

        if (activeElement === pageInput && e.key === 'Enter') {
            e.preventDefault();
            handlePageJump();
            pageInput.blur();
            AppState.imageModalInstance._element.focus({ preventScroll: true });
            return;
        }
      
        if (activeElement === pageInput) {
            if (e.key === 'Escape') {
              pageInput.blur();
            }
            return;
        }

        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          switch (e.key) {
            case 'ArrowLeft': document.getElementById('modalPrevPageButton').click(); break;
            case 'ArrowRight': document.getElementById('modalNextPageButton').click(); break;
            case 'ArrowUp': document.getElementById('modalPrevResultButton').click(); break;
            case 'ArrowDown': document.getElementById('modalNextResultButton').click(); break;
          }
          return;
        }

        if (e.key >= '0' && e.key <= '9') {
          pageInput.focus();
          return;
        }
      }
    
      function getLastName(path) {
        if (path === "") return "(トップレベル)";
        const parts = path.split(" > ");
        return parts[parts.length - 1];
      };

      document.addEventListener('DOMContentLoaded', function() {
        
        // (★) 修正: すべての要素取得に null チェックを追加
        
        const modalEl = document.getElementById('imageModal');
        if (modalEl) {
          AppState.modalElement = modalEl;
          AppState.imageModalInstance = new bootstrap.Modal(modalEl);

          modalEl.addEventListener('hidden.bs.modal', function () {
            const modalPageLeft = document.getElementById('modalPageLeft');
            const modalPageRight = document.getElementById('modalPageRight');
            if(modalPageLeft) modalPageLeft.innerHTML = '';
            if(modalPageRight) modalPageRight.innerHTML = '';
            if(modalPageLeft) modalPageLeft.dataset.waitingForFileId = '';
            if(modalPageRight) modalPageRight.dataset.waitingForFileId = '';
            
            const modalOcr = document.getElementById('modalOcrText');
            if (modalOcr) modalOcr.textContent = '';

            // (★) プリロードボタンのリセット処理
            if (AppState.preloadCacheButton) {
                AppState.preloadCacheButton.disabled = false;
                AppState.preloadCacheButton.textContent = 'オフラインで読む';
            }

            // (★) プリロード状態（進捗追跡）のリセット
            const manager = AppState.downloadManager;
            if (manager.preloadToast) {
                if (manager.preloadFetched < manager.preloadTotal) {
                    const toastBody = manager.preloadToast._element.querySelector('.toast-body');
                    if(toastBody) toastBody.innerHTML = `キャッシュ(バックグラウンド実行中)... (${manager.preloadFetched} / ${manager.preloadTotal})`;
                }

            }

            if (manager.preloadingFolder) {
                // (★) 修正: プリロードが完了していない場合は、null化しない
                if (manager.preloadFetched >= manager.preloadTotal) {
                    // 完了済みの場合はリセット
                    console.log(`Preload tracking (already complete) stopped for folder: ${manager.preloadingFolder}`);
                    manager.preloadingFolder = null;
                    manager.preloadTotal = 0;
                    manager.preloadFetched = 0;
                    manager.preloadToast = null;
                } else {
                    // 実行中の場合は、モーダルを閉じたことだけをログに残す
                    console.log(`Modal closed, but preload is still running for: ${manager.preloadingFolder}`);
                }
            }
            
            if (AppState.isReadingMode) {
              toggleReadingMode(true); // 状態をリセット
            }
          });

        } else {
          console.error("致命的エラー: #imageModal が見つかりません。");
        }

        document.addEventListener('keydown', handleModalKeydown);
      
        const modalPrevResult = document.getElementById('modalPrevResultButton');
        if (modalPrevResult) modalPrevResult.addEventListener('click', () => { if (AppState.currentModalIndex > 0) showImageModal(AppState.currentModalIndex - 1); });
        
        const modalNextResult = document.getElementById('modalNextResultButton');
        if (modalNextResult) modalNextResult.addEventListener('click', () => { if (AppState.currentModalIndex < AppState.currentFilteredResults.length - 1) showImageModal(AppState.currentModalIndex + 1); });
        
        const modalPrevPage = document.getElementById('modalPrevPageButton');
        if (modalPrevPage) modalPrevPage.addEventListener('click', (e) => updateModalContent(e.target.dataset.fileId, e.target.dataset.folderName, e.target.dataset.fileName, true));
        
        const modalNextPage = document.getElementById('modalNextPageButton');
        if (modalNextPage) modalNextPage.addEventListener('click', (e) => updateModalContent(e.target.dataset.fileId, e.target.dataset.folderName, e.target.dataset.fileName, true));

        const readingModeBtn = document.getElementById('toggleReadingModeButton');
        if (readingModeBtn) readingModeBtn.addEventListener('click', () => toggleReadingMode(false));
        
        AppState.preloadCacheButton = document.getElementById('preloadCacheButton');
        if (AppState.preloadCacheButton) {
          AppState.preloadCacheButton.addEventListener('click', () => {
            // 現在モーダルで開いているフォルダ名を渡してプリロードを開始
            if (AppState.currentFolderName) {
              preloadFolderThumbnails(AppState.currentFolderName);
            }
          });
        }

        // (★) プログレスバー関連のDOM取得は先に行う
        AppState.loadingProgressBar = document.getElementById('loadingProgressBar');
        AppState.cacheLoadingText = document.getElementById('cacheLoadingText');
       
        // (★) cacheLoadTimer の設定も先に行う
        if (AppState.cacheLoadTimer) clearInterval(AppState.cacheLoadTimer); // 念のためクリア
        AppState.cacheLoadTimer = setInterval(() => {
          if (AppState.currentProgress < AppState.targetProgress) {
            const step = 1;
            AppState.currentProgress = Math.min(AppState.currentProgress + step, AppState.targetProgress);
            let percent = Math.floor(AppState.currentProgress);
            if (AppState.loadingProgressBar) {
              AppState.loadingProgressBar.style.width = percent + '%';
              AppState.loadingProgressBar.textContent = percent + '%';
              AppState.loadingProgressBar.setAttribute('aria-valuenow', percent);
            }
          }
          if (AppState.currentProgress >= 100) {
            clearInterval(AppState.cacheLoadTimer);
          }
        }, 120);
        
        // (★) 起動メッセージはここでは設定しない (async 関数の中で設定)
       
        (async () => {
          // ( ... 既存の thumbnailCache 読み込み ... )
          try {
            const dbCheck = await dbPromise;
            if (dbCheck.objectStoreNames.contains('thumbnail-cache')) {
              const tx = dbCheck.transaction('thumbnail-cache', 'readonly');
              const store = tx.objectStore('thumbnail-cache');
              const keys = await store.getAllKeys();
              const values = await store.getAll();
              keys.forEach((key, index) => {
                AppState.thumbnailCache[key] = values[index];
              });
              console.log(`Loaded ${keys.length} thumbnails from IndexedDB into memory cache.`);
            } else {
              console.warn("Thumbnail cache store not found.");
            }
          } catch (e) {
            console.error("Failed to load thumbnail cache from DB:", e);
          }
          // (★) ↓↓↓ 起動ロジックをここから変更 ↓↓↓
          try {
            // 1. まずプログレスバーを表示
            const cacheLoadingEl = document.getElementById('cacheLoading');
            if (cacheLoadingEl) cacheLoadingEl.style.display = 'block';
            AppState.cacheLoadingText.textContent = '更新を確認中...';
            AppState.targetProgress = 5;

            // 2. データベースを準備
            const db = await dbPromise;
            const localVersion = await db.get('keyval', 'masterVersion');
            
            // 3. サーバーから最新の "InitialData" (version含む) を fetch
            const initialDataResponse = await fetch(GAS_API_URL + "?action=getInitialData", {
                credentials: 'include'
            });
            if (!initialDataResponse.ok) {
              throw new Error('Failed to fetch initial data: ' + initialDataResponse.statusText);
            }
            const initialData = await initialDataResponse.json();
            
            // 4. 取得したデータからサーバーバージョンを抜き出す
            const serverVersion = initialData.version; // (★) GASから 'version' を受け取る
            if (!serverVersion) {
              throw new Error('Server version not found in API response. Check GAS getInitialData()');
            }
            console.log("Server Master Version:", serverVersion);

            // 5. バージョンを比較
            if (localVersion && localVersion === serverVersion && serverVersion !== 'no-version-set') {
              // (A) バージョンが同じ場合
              console.log("マスターバージョンが最新です。IndexedDBから直接読み込みます。");
              AppState.cacheLoadingText.textContent = '更新はありません。ブラウザキャッシュを展開中...';
              AppState.targetProgress = 70;
              await loadDataFromDBAndSetupUI(); 
              return; // 処理完了
            }

            // (B) バージョンが異なる、または初回起動の場合
            console.log(`バージョンが異なります (Server: ${serverVersion}, Local: ${localVersion})。サーバーから取得します。`);
            AppState.cacheLoadingText.textContent = '新しいデータをサーバーから取得します...';
            AppState.targetProgress = 15;
            
            // (★) 既に initialData は取得済みなので、onInitialDataReceived を呼ぶ
            await onInitialDataReceived(initialData); 
            
            await db.put('keyval', serverVersion, 'masterVersion');
            console.log("ローカルのマスターバージョンを更新しました。");

          } catch (err) {
            // (★) エラー時もプログレスバーを表示してエラーを出す
            const cacheLoadingEl = document.getElementById('cacheLoading');
            if (cacheLoadingEl) cacheLoadingEl.style.display = 'block';
            onDataLoadError(err);
          }
        })();
          
        const searchBox = document.getElementById('searchBox');
        if (searchBox) {
          searchBox.addEventListener('input', function(e) {
            const clearBtn = document.getElementById('clearSearchButton');
            const recentSearchesContainer = document.getElementById('recentSearchesContainer');
            
            if (this.value.length > 0) {
              if (clearBtn) clearBtn.style.display = 'block';
              searchBox.classList.remove('rounded-end');
              if (recentSearchesContainer) recentSearchesContainer.style.display = 'none';
            } else {
              if (clearBtn) clearBtn.style.display = 'none';
              searchBox.classList.add('rounded-end');
              const hasHistory = loadRecentSearches();
              if (hasHistory && recentSearchesContainer) {
                recentSearchesContainer.style.display = 'block';
              } else if (recentSearchesContainer) {
                recentSearchesContainer.style.display = 'none';
              }
            }
            
            /* (インクリメンタルサーチは削除済み)
            if (AppState.searchTimer) clearTimeout(AppState.searchTimer);
            AppState.searchTimer = setTimeout(() => {
              runSearch(false);
            }, 750);
            */
          });
          
          searchBox.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
              const searchBtn = document.getElementById('searchButton');
              if (searchBtn && !searchBtn.disabled) {
                runSearch(true);
              }
            }
          });
          
          searchBox.addEventListener('click', () => {
            const recentSearchesContainer = document.getElementById('recentSearchesContainer');
            const hasHistory = loadRecentSearches();
            if (hasHistory && recentSearchesContainer) {
              recentSearchesContainer.style.display = 'block';
            } else if (recentSearchesContainer) {
              recentSearchesContainer.style.display = 'none';
            }
          });
        } // if(searchBox)
        
        const clearSearchBtn = document.getElementById('clearSearchButton');
        if (clearSearchBtn) clearSearchBtn.addEventListener('click', clearSearch);

        const pageInput = document.getElementById('modalPageInput');
        if (pageInput) {
          pageInput.addEventListener('focus', (e) => {
              pageInput.select();
          });
          pageInput.addEventListener('blur', () => {
            handlePageJumpReset();
          });
        }

        document.addEventListener('click', (e) => {
          const recentSearchesContainer = document.getElementById('recentSearchesContainer');
          if (recentSearchesContainer && !e.target.closest('#searchContainer')) {
            recentSearchesContainer.style.display = 'none';
          }
        });

        window.addEventListener('offline', () => {
          showToast('オフラインになりましたが、テキストデータは読込済みのため検索は利用可能です。', 'warning');
        });
        
        window.addEventListener('online', () => {
          if (AppState.offlineToastInstance) {
            AppState.offlineToastInstance.hide();
            AppState.offlineToastInstance = null;
          }
          showToast('オンラインに復帰しました。', 'success');
        });
        
      }); // (★) DOMContentLoaded の終了

      function buildFolderList(folderData) {
        const container = document.getElementById('folderList');
        container.innerHTML = `
          <div class="list-group-item folder-checkbox-item" 
               onclick="handleFolderClick(event, this)" 
               ondblclick="handleFolderDoubleClick(event, this)">
            <div class="folder-item-left">
              <span class="folder-spacer"></span> 
              <input type="checkbox" id="checkAllFolders" checked onchange="toggleAllCheckboxes(this.checked)">
              <label for="checkAllFolders"><strong>すべてのマニュアル</strong></label>
            </div>
            <span id="totalFolderCount" class="badge bg-secondary rounded-pill"></span>
          </div>
        `;
        const hierarchy = {};
        
        folderData.forEach(data => {
          const path = data.path;
          const order = data.order;
          const isCollapsed = data.isCollapsed || false; // (★) データを取得
          
          let currentLevel = hierarchy;
          
          if (path === "") { 
             if (!currentLevel["(トップレベル)"]) {
                // (★) _isCollapsed を追加
                currentLevel["(トップレベル)"] = { _name: "(トップレベルのマニュアル)", _path: "", _order: "", _isCollapsed: false };
             }
             return;
          }
          
          const parts = path.split(" > ");
          
          parts.forEach((part, index) => {
            if (!currentLevel[part]) {
               currentLevel[part] = { _name: part, _order: "", _isCollapsed: false };
            }
            
            if (index === parts.length - 1) {
              currentLevel[part]._order = order;
              currentLevel[part]._isCollapsed = isCollapsed;
            }
            
            currentLevel = currentLevel[part];
          });
        });
        
        let folderCounter = 0; 
        
        const createHtml = (node, currentPath) => {
          let html = '';
          const keys = Object.keys(node).filter(k => k !== '_name' && k !== '_path' && k !== '_order' && k !== '_isCollapsed');

          keys.sort((a, b) => {
            const nodeA = node[a];
            const nodeB = node[b];
            const orderA_raw = nodeA._order;
            const orderB_raw = nodeB._order;
            const nameA = nodeA._name;
            const nameB = nodeB._name;
            const orderA_exists = (orderA_raw !== null && orderA_raw !== undefined && orderA_raw !== "");
            const orderB_exists = (orderB_raw !== null && orderB_raw !== undefined && orderB_raw !== "");

            if (orderA_exists && orderB_exists) {
              const orderA_str = String(orderA_raw);
              const orderB_str = String(orderB_raw);
              if (orderA_str === orderB_str) {
                return nameA.localeCompare(nameB, 'ja', { numeric: true });
              }
              return orderA_str.localeCompare(orderB_str, 'ja', { numeric: true });
            }
            if (orderA_exists && !orderB_exists) return -1;
            if (!orderA_exists && orderB_exists) return 1;
            return nameA.localeCompare(nameB, 'ja', { numeric: true });
          });

          keys.forEach(key => {
            const childNode = node[key];
            const nodeName = childNode._name;
            const fullPath = (childNode._path !== undefined) ? childNode._path : (currentPath ? [currentPath, nodeName].join(" > ") : nodeName);
            const childrenHtml = createHtml(childNode, fullPath);
            const inputId = 'folder_' + (folderCounter++); 
            const collapseId = 'collapse_' + inputId; 
            if (fullPath === "") return; 
            const hasChildren = !!childrenHtml;

            const isCollapsed = childNode._isCollapsed || false;
            const collapsedClass = isCollapsed ? 'collapsed' : '';
            const expandedState = isCollapsed ? 'false' : 'true';
            const showClass = isCollapsed ? '' : 'show';

            const toggleElement = hasChildren 
              ? `<a class="folder-toggle ${collapsedClass}" data-bs-toggle="collapse" href="#${collapseId}" role="button" aria-expanded="${expandedState}" aria-controls="${collapseId}"></a>`
              : `<span class="folder-spacer"></span>`;
            
            html += `
              <div class="list-group-item folder-checkbox-item" 
                   onclick="handleFolderClick(event, this)" 
                   ondblclick="handleFolderDoubleClick(event, this)">
                <div class="folder-item-left">
                  ${toggleElement} 
                  <input type="checkbox" id="${inputId}" class="folder-checkbox" value="${fullPath}" checked onchange="handleCheckboxChange(this)">
                  <label for="${inputId}">${nodeName}</label>
                </div>
                <span class="badge bg-secondary rounded-pill folder-count-item"></span>
              </div>
            `;
            if (childrenHtml) html += `<div class="nested-list-group collapse ${showClass}" id="${collapseId}">${childrenHtml}</div>`; 
          });
          return html;
        };
        container.innerHTML += createHtml(hierarchy, "");
      }

      function onFolderLoadError(error) {
        document.getElementById('folderList').innerHTML =
          '<div class="list-group-item text-danger">マニュアル階層の読み込みに失敗しました: ' + error.message + '</div>';
      }

      async function onInitialDataReceived(initialData) {
        
        const masterData = initialData.master;
        const serverManifest = initialData.manifest;

        try {
          const folderData = masterData.map(row => ({
            path: row[2],
            order: row[4],
            isCollapsed: row[5] || false
          }));
          
          buildFolderList(folderData);

          AppState.folderSortOrderMap.clear();
          masterData.forEach(row => {
            const path = row[2];
            const order = row[4];
            AppState.folderSortOrderMap.set(path, order || ""); 
          });
          console.log("Created folderSortOrderMap with " + AppState.folderSortOrderMap.size + " entries.");
        } catch (e) {
          onFolderLoadError(e); 
        }
        
        let db;
        try {
          db = await dbPromise;
          await db.put('keyval', masterData, 'folderMaster'); 
          console.log("フォルダマスタ(辞書)をIndexedDB('keyval')に保存しました。");
        } catch (e) {
          console.error("フォルダマスタのDB保存に失敗:", e); 
          onDataLoadError({ message: "フォルダ辞書の保存に失敗しました。" });
          return; 
        }

        let localManifest;
        try {
          localManifest = await db.get('keyval', 'folderManifest') || {};
        } catch (e) {
          console.error("ローカルマニフェストの取得に失敗:", e);
          localManifest = {};
        }

        const foldersToFetch = [];
        const foldersToDelete = [];
        
        for (const folderName in serverManifest) {
          const serverTs = serverManifest[folderName];
          const localTs = localManifest[folderName];
          if (!localTs || localTs !== serverTs) {
            foldersToFetch.push(folderName);
          }
        }
        for (const folderName in localManifest) {
          if (!serverManifest[folderName]) {
            foldersToDelete.push(folderName);
          }
        }
        
        if (foldersToFetch.length === 0 && foldersToDelete.length === 0) {
          AppState.cacheLoadingText.textContent = '更新はありません。ブラウザキャッシュを展開中...';
          AppState.targetProgress = 70;
          await loadDataFromDBAndSetupUI(); 
          return;
        }

        if (foldersToFetch.length > 0) {
          
          function runSimulation() {
            const totalFolders = foldersToFetch.length;
            const estimatedTime = 500 + (totalFolders * 400);
            const simulationStep = 100;
            const progressStep = (90 - AppState.targetProgress) * (simulationStep / estimatedTime);

            if (AppState.simulationTimer) {
              clearTimeout(AppState.simulationTimer);
            }

            const simulate = () => {
              if (AppState.targetProgress < 89) {
                AppState.targetProgress += progressStep;
                
                const currentFolderIndex = Math.floor((AppState.targetProgress / 90) * totalFolders);
                if (foldersToFetch[currentFolderIndex]) {
                  const shortName = getLastName(foldersToFetch[currentFolderIndex]);
                  AppState.cacheLoadingText.textContent = `サーバーからデータを取得中... (${currentFolderIndex + 1} / ${totalFolders}) ${shortName}`;
                } else {
                  AppState.cacheLoadingText.textContent = `サーバーからデータを取得中...`;
                }
                
                AppState.simulationTimer = setTimeout(simulate, simulationStep);
              }
            };
            
            simulate();
          }

          // (★) 修正: fetch を使った POST リクエストに変更
            fetch(GAS_API_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain' },
              body: JSON.stringify({
                action: 'getDataForFolders', // doPost で判別するためのキー
                folders: foldersToFetch      // 送信するフォルダ配列
              }),
              credentials: 'include'
            })
            .then(res => {
              if (!res.ok) throw new Error("API request failed");
              return res.json();
            })
            .then(async (changedData) => { // (★) withSuccessHandler と同じ
                
              if (AppState.simulationTimer) {
                clearTimeout(AppState.simulationTimer);
                AppState.simulationTimer = null;
              }
              AppState.targetProgress = 90;

              const folderNames = Object.keys(changedData);
              const totalSaveFolders = folderNames.length;
              
              if (totalSaveFolders === 0) {
                 AppState.cacheLoadingText.textContent = 'ダウンロード完了。(更新データなし)';
                 AppState.targetProgress = 95;
              } else {
                 AppState.cacheLoadingText.textContent = 'ダウンロード完了。ブラウザに保存します...';
              }
              
              let tx;
              try {
                const masterData = await db.get('keyval', 'folderMaster'); 
                if (!masterData) {
                  throw new Error("フォルダ辞書(masterData)がDBから取得できませんでした。");
                }
                
                const idToPath = new Map();
                masterData.forEach(row => {
                  idToPath.set(row[0], row[2]); 
                });

                tx = db.transaction(['files', 'keyval'], 'readwrite');
                const fileStore = tx.objectStore('files');
                const keyvalStore = tx.objectStore('keyval');
                
                let i = 0;
                
                if (foldersToDelete.length > 0) {
                   AppState.cacheLoadingText.textContent = `古いデータ(${foldersToDelete.length}件)を削除中...`;
                   const pathIndex = fileStore.index('byPath');
                   for (const folderName of foldersToDelete) {
                   const filesToDelete = await pathIndex.getAll(folderName);
                     for (const file of filesToDelete) {
                       await fileStore.delete(file.id); 
                     }
                   }
                }

                for (const folderName in changedData) {
                  i++;
                  const shortName = getLastName(folderName);
                  AppState.cacheLoadingText.textContent = `ブラウザに保存中... (${i} / ${totalSaveFolders}) ${shortName}`;
                  AppState.targetProgress = Math.floor(90 + ( (i / totalSaveFolders) * 5 ));
                  
                  const folderArray = changedData[folderName];
                  if (!Array.isArray(folderArray)) continue;

                  for (const row_4col of folderArray) {
                    const folderId = row_4col[3];
                    const path = idToPath.get(folderId); 
                    
                    if (path !== undefined) {
                      const fileObject = {
                        path: path, name: row_4col[0], id: row_4col[1], ocr: row_4col[2], folderId: folderId
                    };
                      await fileStore.put(fileObject);
                    } else {
                      console.warn(`パスが見つかりません: FolderID=${folderId}, Name=${row_4col[0]}`);
                    }
                  }
                }
                
                AppState.cacheLoadingText.textContent = '更新記録を保存中...';
                await keyvalStore.put(serverManifest, 'folderManifest');
                await tx.done;
              } catch (e) {
                if (tx) tx.abort(); 
                console.error("データベースへの保存トランザクションに失敗:", e);
                onDataLoadError({ message: "データベースの保存に失敗しました。" });
                return; 
              }
              await loadDataFromDBAndSetupUI();
            })
            .catch(onDataLoadError); // (★) withFailureHandler と同じ


          runSimulation(); 

        } else {
          AppState.cacheLoadingText.textContent = `削除された${foldersToDelete.length}件のフォルダデータをクリーンアップ中...`;
         
          let tx;
          try {
            tx = db.transaction(['files', 'keyval'], 'readwrite');
            const fileStore = tx.objectStore('files');
            const keyvalStore = tx.objectStore('keyval');
            const pathIndex = fileStore.index('byPath');

            for (const folderName of foldersToDelete) {
              const filesToDelete = await pathIndex.getAll(folderName);
              for (const file of filesToDelete) {
                await fileStore.delete(file.id); 
              }
            }
            await keyvalStore.put(serverManifest, 'folderManifest');
            await tx.done;

          } catch (e) {
             if (tx) tx.abort();
             console.error("データベース(削除)トランザクションに失敗:", e);
             onDataLoadError({ message: "データベースのクリーンアップに失敗しました。" });
             return;
          }
          
          await loadDataFromDBAndSetupUI();
        }
      }

      async function loadDataFromDBAndSetupUI() {
        try {
          const db = await dbPromise;
        
          // (★) 1. フォルダマスタ (Sidebar用) をDBから取得
          const masterData = await db.get('keyval', 'folderMaster');
          if (!masterData) {
            // ローカルにマスタがない場合 (初回DB構築直後など)
            // この場合、バージョンチェックを失敗させるのが安全
            console.warn("ローカルに folderMaster が見つかりません。サーバーから再取得を試みます。");
            await db.delete('keyval', 'masterVersion'); 
            location.reload(); // 強制的にリロード
            return; 
          }
          
          // (★) 2. フォルダリストを構築 (変更なし)
          const folderData = masterData.map(row => ({
            path: row[2],
            order: row[4],
            isCollapsed: row[5] || false
          }));
          buildFolderList(folderData);

          // (★) 3. ソートマップも構築 (変更なし)
          AppState.folderSortOrderMap.clear();
          masterData.forEach(row => {
            const path = row[2];
            const order = row[4];
            AppState.folderSortOrderMap.set(path, order || "");
          });
          console.log("Loaded folderSortOrderMap from DB cache.");

          // (★) 4. ファイルデータ (検索用) の取得を削除
          AppState.cacheLoadingText.textContent = 'データを展開中...';
          AppState.targetProgress = 97;
          // (★) db.getAll('files') を削除
          
          // (★) 5. UIをセットアップ (引数なしで呼び出す)
          setupUI();

        } catch (e) {
          console.error("DBからのデータ展開に失敗:", e);
          onDataLoadError({ message: "データベースからのデータ展開に失敗しました。" });
        }
      }

      function setupUI() {
        AppState.targetProgress = 97;

        setTimeout(() => {
          // (★) ↓↓↓ この行を削除 ↓↓↓
          // AppState.allFilesData = data;
          
          const searchBox = document.getElementById('searchBox');
          searchBox.disabled = false;
          document.getElementById('searchButton').disabled = false;
          
          document.getElementById('stickyControls').style.display = 'none';
        
          searchBox.focus();
          AppState.targetProgress = 100;
          AppState.cacheLoadingText.textContent = '読み込み完了';
        
          setTimeout(() => {
            document.getElementById('cacheLoading').style.display = 'none';
          }, 500);

        }, 100);
      }

      function onDataLoadError(error) {
        if (AppState.cacheLoadTimer) clearInterval(AppState.cacheLoadTimer);
        if (AppState.simulationTimer) clearTimeout(AppState.simulationTimer);

        AppState.loadingProgressBar.style.width = '100%';
        AppState.loadingProgressBar.classList.remove('progress-bar-animated');
        AppState.loadingProgressBar.classList.add('bg-danger');
        AppState.loadingProgressBar.textContent = 'エラー';
      
        AppState.cacheLoadingText.innerHTML = '<strong>エラー: </strong>データのキャッシュに失敗しました。ページを再読み込みしてください。<br>' + (error.message || '不明なエラー');
      }
    
      function handleCheckboxChange(checkbox) {
        const isChecked = checkbox.checked;
        const li = checkbox.closest('.list-group-item');
        const childContainer = li.nextElementSibling;
        if (childContainer && childContainer.classList.contains('nested-list-group')) {
          const childCheckboxes = childContainer.querySelectorAll('.folder-checkbox');
          childCheckboxes.forEach(cb => { cb.checked = isChecked; cb.indeterminate = false; });
        }
        updateParentCheckboxStates(li);
        renderFilteredResults();
      }

      function updateParentCheckboxStates(listItem) {
        let currentElement = listItem.parentElement;
        while (currentElement && (currentElement.classList.contains('nested-list-group') || currentElement.id === 'folderList')) {
          const parentLi = currentElement.previousElementSibling;
          if (!parentLi || !parentLi.classList.contains('list-group-item')) {
            if (currentElement.id === 'folderList') updateCheckAllState();
            break;
          }
          const parentCheckbox = parentLi.querySelector('input[type="checkbox"]');
          if (!parentCheckbox) break;
          if (parentCheckbox.id === 'checkAllFolders') { updateCheckAllState(); break; }
        
          const childCheckboxes = currentElement.querySelectorAll('.folder-checkbox');
          if (childCheckboxes.length > 0) {
            const allChildrenChecked = Array.from(childCheckboxes).every(cb => cb.checked);
            const someChildrenChecked = Array.from(childCheckboxes).some(cb => cb.checked || cb.indeterminate);
            if (allChildrenChecked) {
              parentCheckbox.checked = true;
              parentCheckbox.indeterminate = false;
            } else if (someChildrenChecked) {
              parentCheckbox.checked = false;
              parentCheckbox.indeterminate = true;
            } else {
              parentCheckbox.checked = false;
              parentCheckbox.indeterminate = false;
            }
          }
          currentElement = parentLi.parentElement;
        }
      }

      function toggleAllCheckboxes(isChecked) {
        const checkAll = document.getElementById('checkAllFolders');
        if (checkAll) {
            checkAll.checked = isChecked;
            checkAll.indeterminate = false;
        }
        document.querySelectorAll('.folder-checkbox').forEach(cb => {
            cb.checked = isChecked;
            cb.indeterminate = false;
        });
        renderFilteredResults();
      }

      function updateCheckAllState() {
        const allCheckboxes = document.querySelectorAll('.folder-checkbox');
        if (allCheckboxes.length === 0) return;
        const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
        const someChecked = Array.from(allCheckboxes).some(cb => cb.checked || cb.indeterminate);
        const checkAll = document.getElementById('checkAllFolders');
        if (!checkAll) return;
        if (allChecked) {
          checkAll.checked = true;
          checkAll.indeterminate = false;
        } else if (someChecked) {
          checkAll.checked = false;
          checkAll.indeterminate = true;
        } else {
          checkAll.checked = false;
          checkAll.indeterminate = false;
        }
      }
    
      function numericSort(a, b) {
        const strA = String(a[1]);
        const strB = String(b[1]);
        const numA = parseInt(strA.match(/\d+/) || 0, 10);
        const numB = parseInt(strB.match(/\d+/) || 0, 10);
        if (numA !== numB) return numA - numB;
        return strA.localeCompare(strB, undefined, { numeric: true });
      }

      /**
       * (★) 新規追加: DBをカーソルで検索するヘルパー関数
       */
      function searchDBWithCursor(includeKeywords, phraseKeywords, excludeKeywords, highlightKeywords) {
        return new Promise(async (resolve, reject) => {
          try {
            const db = await dbPromise;
            const tx = db.transaction('files', 'readonly');
            const store = tx.objectStore('files');
            
            const results = [];
            let cursor = await store.openCursor();

            while (cursor) {
              const fileData = cursor.value;
              const ocrText = fileData.ocr || "";
              
              if (ocrText && !ocrText.startsWith("OCRエラー:")) {
                const ocrTextLower = ocrText.toLowerCase();

                // (★) 以前の forEach 内のロジックをそのまま流用
                const isIncludeMatch = includeKeywords.every(k => ocrTextLower.includes(k));
                const isPhraseMatch = phraseKeywords.every(p => ocrTextLower.includes(p));
                const isExcludeMatch = excludeKeywords.some(k => ocrTextLower.includes(k));

                if (isIncludeMatch && isPhraseMatch && !isExcludeMatch) {
                  // スニペット生成ロジック (runSearchからコピー)
                  let ocrSnippet = "", earliestHitIndex = Infinity, earliestKeywordLength = 0;
                  
                  highlightKeywords.forEach(k => {
                    const idx = ocrTextLower.indexOf(k);
                    if (idx !== -1 && idx < earliestHitIndex) {
                      earliestHitIndex = idx;
                      earliestKeywordLength = k.length;
                    }
                  });
                  
                  if (earliestHitIndex === Infinity && highlightKeywords.length === 0) {
                    earliestHitIndex = 0; earliestKeywordLength = 0;
                  }

                  if (earliestHitIndex !== Infinity) {
                    const hitIndex = earliestHitIndex;
                    const snippetLength = 200;
                    const startIndex = Math.max(0, hitIndex - (snippetLength / 2));
                    if (startIndex > 0) ocrSnippet += "...";
                    const endIndex = Math.min(ocrText.length, hitIndex + earliestKeywordLength + (snippetLength / 2));
                    ocrSnippet += ocrText.substring(startIndex, endIndex);
                    if (endIndex < ocrText.length) ocrSnippet += "...";
                  }
                  
                  const highlightedOcrSnippet = escapeAndHighlight(ocrSnippet, highlightKeywords);

                  results.push({
                    folderName: fileData.path,
                    fileName: fileData.name,
                    fileId: fileData.id,
                    snippet: highlightedOcrSnippet
                  });
                }
              }
              cursor = await cursor.continue(); // 次のレコードへ
            }
            
            resolve(results); // 全件検索が終わったら結果を返す
          } catch (err) {
            reject(err);
          }
        });
      }

      // (★) 修正: async 関数に変更
      async function runSearch(showSpinner = false) {
        document.getElementById('stickyControls').style.display = 'flex';
        document.getElementById('results').style.paddingTop = '124px';
     
        if (AppState.searchTimer) {
          clearTimeout(AppState.searchTimer);
          AppState.searchTimer = null;
        }
        if (showSpinner) document.getElementById('loading').style.display = 'block';
        document.getElementById('resultList').innerHTML = '';
        AppState.allSearchResults = [];
     
        const query = document.getElementById('searchBox').value;
     
        // (★) キーワードのパース処理 (変更なし)
        const includeKeywords = [];
        const excludeKeywords = [];
        const phraseKeywords = [];
        const phraseRegex = /"([^"]+)"/g;
       
        let match;
        while ((match = phraseRegex.exec(query)) !== null) {
          if (match[1] && match[1].trim() !== "") {
            phraseKeywords.push(match[1].toLowerCase());
          }
        }
        const remainingQuery = query.replace(phraseRegex, ' ').trim();
        if (remainingQuery.length > 0) {
          const allKeywordsRaw = remainingQuery.toLowerCase().split(' ').filter(k => k.trim() !== '');
          allKeywordsRaw.forEach(k => {
            if (k.startsWith('-') && k.length > 1) excludeKeywords.push(k.substring(1));
            else if (k.length > 0) includeKeywords.push(k);
          });
        }
        AppState.currentSearchKeywords = [...includeKeywords, ...phraseKeywords];
     
        if (query.trim() !== "") {
          document.getElementById('recentSearchesContainer').style.display = 'none';
          saveRecentSearch(query);

          if (includeKeywords.length > 0 || excludeKeywords.length > 0 || phraseKeywords.length > 0) {
            // (★) ↓↓↓ ここからDB検索に変更 ↓↓↓
            try {
              AppState.allSearchResults = await searchDBWithCursor(
                includeKeywords, 
                phraseKeywords, 
                excludeKeywords, 
                AppState.currentSearchKeywords
              );
            } catch (err) {
              console.error("Cursor search failed:", err);
              showError(err);
            }
            // (★) ↑↑↑ ここまで変更 ↑↑↑
          }
        } else {
          AppState.allSearchResults = [];
        }
   
        // (★) ソート処理 (変更なし)
        AppState.allSearchResults.sort((a, b) => {
          // ... (既存のソートロジック) ...
          const pathA = a.folderName;
          const pathB = b.folderName;
          const partsA = pathA === "" ? [] : pathA.split(" > ");
          const partsB = pathB === "" ? [] : pathB.split(" > ");
          const maxDepth = Math.max(partsA.length, partsB.length);
     
          for (let i = 0; i < maxDepth; i++) {
            const partA = partsA[i];
            const partB = partsB[i];
       
            if (partA === undefined) return -1;
            if (partB === undefined) return 1;
       
            const currentPathA = partsA.slice(0, i + 1).join(" > ");
            const currentPathB = partsB.slice(0, i + 1).join(" > ");
       
            const orderA_raw = AppState.folderSortOrderMap.get(currentPathA) || "";
            const orderB_raw = AppState.folderSortOrderMap.get(currentPathB) || "";
       
            const nameA = partA;
            const nameB = partB;

            const orderA_exists = (orderA_raw !== null && orderA_raw !== undefined && orderA_raw !== "");
            const orderB_exists = (orderB_raw !== null && orderB_raw !== undefined && orderB_raw !== "");

            let compareResult = 0;

            if (orderA_exists && orderB_exists) {
              const orderA_str = String(orderA_raw);
              const orderB_str = String(orderB_raw);
              compareResult = orderA_str.localeCompare(orderB_str, 'ja', { numeric: true });
              if (compareResult === 0) {
                  compareResult = nameA.localeCompare(nameB, 'ja', { numeric: true });
              }
            } else if (orderA_exists && !orderB_exists) {
              compareResult = -1;
            } else if (!orderA_exists && orderB_exists) {
              compareResult = 1;
            } else {
              compareResult = nameA.localeCompare(nameB, 'ja', { numeric: true });
            }

            if (compareResult !== 0) {
              return compareResult;
              }
          }
     
          return numericSort([0, a.fileName], [0, b.fileName]);
        });

        if (showSpinner) {
          document.getElementById('loading').style.display = 'none';
        }
        renderFilteredResults();
      }

      function clearSearch() {
        const searchBox = document.getElementById('searchBox');
        searchBox.value = '';
        document.getElementById('clearSearchButton').style.display = 'none';
        searchBox.classList.add('rounded-end');
        runSearch(false);
      
        document.getElementById('stickyControls').style.display = 'none';
        document.getElementById('results').style.paddingTop = '0';
        const recentSearchesContainer = document.getElementById('recentSearchesContainer');
        const hasHistory = loadRecentSearches();
        if (hasHistory) {
          recentSearchesContainer.style.display = 'block';
        } else {
          recentSearchesContainer.style.display = 'none';
        }

        searchBox.focus();
      }

      function renderFilteredResults() {
        if (AppState.thumbnailObserver) AppState.thumbnailObserver.disconnect();
        AppState.thumbnailsToFetch.clear();
    
        const list = document.getElementById('resultList');
        const paginationContainer = document.getElementById('paginationContainer');
        const summaryEl = document.getElementById('resultSummary');
      
        list.innerHTML = '';
        paginationContainer.innerHTML = ''; 
        summaryEl.style.display = 'none';

        // --- フォルダ件数バッジの計算 ---
        let folderCounts = {};
        AppState.allSearchResults.forEach(function(result) {
          const path = result.folderName;
          if (path === undefined || path === null) return;
          folderCounts[path] = (folderCounts[path] || 0) + 1;
          if(path !== "") {
            const parts = path.split(" > ");
            let currentPath = "";
            for (let i = 0; i < parts.length - 1; i++) {
              currentPath = (currentPath ? [currentPath, parts[i]].join(" > ") : parts[i]);
              folderCounts[currentPath] = (folderCounts[currentPath] || 0) + 1;
            }
          }
        });
        let totalResultCount = AppState.allSearchResults.length;
        const totalCountSpan = document.getElementById('totalFolderCount');
        if(totalCountSpan) {
          if (totalResultCount > 0) {
            totalCountSpan.textContent = totalResultCount;
            totalCountSpan.style.display = 'inline-block';
          } else {
            totalCountSpan.style.display = 'none';
          }
        }
        document.querySelectorAll('.folder-checkbox').forEach(function(cb) {
          let folderPath = cb.value;
          let count = folderCounts[folderPath] || 0;
          let itemDiv = cb.closest('.list-group-item');
          if (itemDiv) {
            let span = itemDiv.querySelector('.badge');
            if (span) {
                if (count > 0) {
                  span.textContent = count;
                  span.style.display = 'inline-block';
                } else {
                  span.style.display = 'none';
                }
            }
          }
        });
        updateFolderItemStyles();

        const checkAllEl = document.getElementById('checkAllFolders');
        const isAllChecked = (checkAllEl ? checkAllEl.checked : true);
        const selectedFolders = new Set();
        if (!isAllChecked) {
          document.querySelectorAll('.folder-checkbox:checked').forEach(cb => {
            selectedFolders.add(cb.value);
          });
        }
      
        AppState.currentFilteredResults = AppState.allSearchResults.filter(function(file) {
          if (isAllChecked) return true;
          const filePath = file.folderName;
          for (const selectedPath of selectedFolders) {
            if (filePath === "" && selectedPath === "") return true;
            if (filePath === selectedPath) return true;
            if (selectedPath !== "" && filePath.startsWith(selectedPath + " > ")) return true;
          }
          return false;
        });

      
        const totalFiltered = AppState.currentFilteredResults.length;
        const totalPages = Math.ceil(totalFiltered / ITEMS_PER_PAGE);

        if (AppState.currentPage > totalPages && totalPages > 0) {
            AppState.currentPage = 1;
        }

        if (totalFiltered === 0) {
          const message = '該当するページが見つかりませんでした。';
          paginationContainer.innerHTML = `<p class="text-center text-muted" style="margin: 0; padding-bottom: 5px;">${message}</p>`;
          list.innerHTML = ''; 
          summaryEl.style.display = 'none';
          return;
        }
      
        summaryEl.innerHTML = `<strong>${totalFiltered}</strong> 件の検索結果`;
        summaryEl.style.display = 'block';

        renderPaginationControls();
        displayPage(AppState.currentPage);
      }

      function showImageModal(index) {
        AppState.currentModalIndex = index;
        const file = AppState.currentFilteredResults[index];
        
        // (★) 読書モードや再描画のために基準となるファイル情報を保存
        AppState.currentFileId = file.fileId;
        AppState.currentFolderName = file.folderName;
        AppState.currentFileName = String(file.fileName);
        
        updateModalContent(file.fileId, file.folderName, String(file.fileName), false);
        
        // (★) 修正: 
        // 取得した要素が null でないかチェックしてから .disabled を設定
        
        const prevBtn = document.getElementById('modalPrevResultButton');
        if (prevBtn) {
          prevBtn.disabled = (index === 0);
        }

        const nextBtn = document.getElementById('modalNextResultButton');
        if (nextBtn) {
          nextBtn.disabled = (index === AppState.currentFilteredResults.length - 1);
        }
        
        // AppState.imageModalInstance が null でないことも確認
        if (AppState.imageModalInstance) {
          AppState.imageModalInstance.show();
        } else {
          console.error("モーダルインスタンスが初期化されていません。");
        }
      }

      // (★) 追加: 読書モード切替関数
      function toggleReadingMode(forceOff = false) {
        if (forceOff) {
          AppState.isReadingMode = false;
        } else {
          AppState.isReadingMode = !AppState.isReadingMode;
        }
        
        const btn = document.getElementById('toggleReadingModeButton');
        if (AppState.isReadingMode) {
          AppState.modalElement.classList.add('modal-reading-mode');
          btn.classList.add('active');
          btn.textContent = '読書モード(ON)';
        } else {
          AppState.modalElement.classList.remove('modal-reading-mode');
          btn.classList.remove('active');
          btn.textContent = '読書モード';
        }

        // (★) 現在開いているファイルIDを基準に、モーダルを再描画
        if (!forceOff) {
          updateModalContent(AppState.currentFileId, AppState.currentFolderName, AppState.currentFileName, false);
        }
      }

      // (★) 修正: async関数に変更し、DBアクセスを追加
      async function updateModalContent(fileId, folderName, fileName, isPageNavigation) {
      
        AppState.currentFileId = fileId;
        AppState.currentFolderName = folderName;
        AppState.currentFileName = fileName;

        const modalFolderPath = document.getElementById('modalFolderPath');
        const modalOcrText = document.getElementById('modalOcrText');
        const modalPageLeft = document.getElementById('modalPageLeft');
        const modalPageRight = document.getElementById('modalPageRight');
        
        // --- 1. タイトルとOCRテキスト (★) DBから fileData を取得
        let displayPath = folderName || "";
        if(modalFolderPath) modalFolderPath.textContent = displayPath;
        
        // (★) ↓↓↓ DBから取得するように変更 ↓↓↓
        const db = await dbPromise;
        const fileData = await db.get('files', fileId); 
        // (★) ↑↑↑ 変更ここまで ↑↑↑
        
        if (modalOcrText && fileData) {
          const ocrText = fileData.ocr || null;
          if (ocrText) {
              if (ocrText.startsWith("OCRエラー:")) {
                  modalOcrText.innerHTML = `<span class="text-danger">${ocrText}</span>`;
              } else {
                  modalOcrText.innerHTML = escapeAndHighlight(ocrText, AppState.currentSearchKeywords);
              }
          } else {
              modalOcrText.textContent = "(OCRテキストが見つかりません)";
          }
        }
        
        // --- 2. フォルダファイル取得 (★) DBから取得
        // (★) ↓↓↓ DBから取得するように変更 ↓↓↓
        const allFolderFiles = await db.getAllFromIndex('files', 'byPath', folderName);
        const folderFiles = allFolderFiles.sort((a, b) => numericSort([0, a.name], [0, b.name]));
        // (★) ↑↑↑ 変更ここまで ↑↑↑
        
        const currentFileStr = String(fileName);
        const folderIndex = folderFiles.findIndex(fileData => String(fileData.name) === currentFileStr);
        
        // ... (以降の処理は変更なし) ...
        let leftFile = null;
        let rightFile = null;

        if (AppState.modalElement) AppState.modalElement.classList.remove('single-landscape');
        const isCurrentFileLandscape = await getIsLandscape(fileId);

        if (AppState.isReadingMode) {
          if (isCurrentFileLandscape) {
            leftFile = null;
            rightFile = fileData;
            if (AppState.modalElement) AppState.modalElement.classList.add('single-landscape');
          } else {
            if (folderIndex === -1) {
              leftFile = null;
              rightFile = fileData;
            } else if (folderIndex === 0) {
              leftFile = null;
              rightFile = folderFiles[0];
            } else if (folderIndex % 2 === 1) {
              leftFile = folderFiles[folderIndex];
              rightFile = (folderIndex + 1 < folderFiles.length) ? folderFiles[folderIndex + 1] : null;
            } else {
              leftFile = folderFiles[folderIndex - 1];
              rightFile = folderFiles[folderIndex];
            }
          }
        } else {
          leftFile = null; 
          rightFile = fileData;
        }

        function renderPage(containerEl, fileToShow) {
          if (!containerEl) return;
          
          if (!fileToShow) {
            containerEl.innerHTML = '';
            containerEl.dataset.waitingForFileId = '';
            return;
          }
          
          const fId = fileToShow.id;
          const dataUrl = AppState.thumbnailCache[fId];
          
          if (dataUrl) {
            renderImageToContainer(containerEl, fId, fileToShow.name, dataUrl);
          } else {
            containerEl.innerHTML = `
              <div class="spinner-border text-secondary" style="width: 3rem; height: 3rem;" role="status">
                <span class="visually-hidden">読み込み中...</span>
              </div>
            `;
            containerEl.dataset.waitingForFileId = fId;
            if (fId && !AppState.thumbnailCache[fId]) {
              requestThumbnails([fId]); // (★) 変更
            }
          }
        }
        
        renderPage(modalPageLeft, leftFile);
        renderPage(modalPageRight, rightFile);
        
        await updatePageNavigation(folderName, fileName, folderFiles, folderIndex, isCurrentFileLandscape);
      }

      // (★) ↓↓↓ ここから新しく追加 ↓↓↓
      /**
       * dataUrl を <img > に変換し、向きを判定してコンテナに描画する
       */
      function renderImageToContainer(containerEl, fileId, fileName, dataUrl) {
        if (!containerEl) return;
        
        const img = new Image();
        img.alt = `プレビュー画像: ${fileName}`;
        
        img.onload = () => {
          // 1. 画像の向きを判定
          const isLandscape = img.naturalWidth > img.naturalHeight;
          
          // 2. dimensionsCache に保存
          if (!AppState.dimensionsCache.has(fileId)) {
            AppState.dimensionsCache.set(fileId, { isLandscape: isLandscape });
          }

          // 3. 読書モード中に右ページの画像が読み込まれた場合、レイアウトを動的に変更
          if (AppState.isReadingMode && containerEl.id === 'modalPageRight') {
            if (isLandscape) {
              // 横長なら、単一表示モードにする
              AppState.modalElement.classList.add('single-landscape');
            } else {
              // 縦長なら、単一表示モードを解除 (見開きに戻す)
              AppState.modalElement.classList.remove('single-landscape');
            }
          }
          
          // 4. コンテナに画像を描画
          containerEl.innerHTML = ''; 
          containerEl.appendChild(img);
          containerEl.dataset.waitingForFileId = '';
        };
        
        img.onerror = () => {
          // 読み込み失敗時
          containerEl.innerHTML = '<span class="text-danger">画像エラー</span>';
          containerEl.dataset.waitingForFileId = '';
        };
        
        img.src = dataUrl;
        
        // 念のため、スピナーを一時的に表示
        containerEl.innerHTML = `
          <div class="spinner-border text-secondary" style="width: 3rem; height: 3rem;" role="status">
            <span class="visually-hidden">読み込み中...</span>
          </div>
        `;
        containerEl.dataset.waitingForFileId = fileId;
      }

      // (★) 修正: async関数に変更し、横長判定(isCurrentLandscape)を引数で受け取る
      async function updatePageNavigation(currentFolder, currentFile, folderFiles, folderIndex, isCurrentLandscape) {
        const prevPageBtn = document.getElementById('modalPrevPageButton');
        const nextPageBtn = document.getElementById('modalNextPageButton');
        const pageInput = document.getElementById('modalPageInput');
        const pageTotal = document.getElementById('modalPageTotal');
        const pageJumper = document.getElementById('modalPageJumper');
        
        if (!prevPageBtn || !nextPageBtn || !pageInput || !pageTotal || !pageJumper) {
          console.error("ページナビゲーション要素が見つかりません。");
          return;
        }
        
        const totalPages = folderFiles.length;

        // --- 1. ページジャンパーの更新 (変更なし) ---
        if (folderIndex !== -1 && totalPages > 0) {
          pageInput.value = currentFile; 
          pageTotal.textContent = ` / ${totalPages} ページ`;
          pageJumper.dataset.currentFolder = currentFolder;
          pageJumper.dataset.currentFileId = folderFiles[folderIndex].id;
        } else {
          pageInput.value = "";
          pageTotal.textContent = " / ? ページ";
          pageJumper.dataset.currentFolder = currentFolder || "";
          pageJumper.dataset.currentFileId = "";
        }

        // --- 2. サムネイルのプリロード (ロジック修正) ---
        const pagesToPreload = [];
        const jumpStep = (AppState.isReadingMode && !isCurrentLandscape) ? 2 : 1;
        
        pagesToPreload.push(folderIndex - jumpStep);
        pagesToPreload.push(folderIndex - jumpStep + 1);
        pagesToPreload.push(folderIndex + jumpStep);
        pagesToPreload.push(folderIndex + jumpStep + 1);

        let addedToFetchList = false;
        const idsToPreload = [];
        pagesToPreload.forEach(index => {
          if (index >= 0 && index < folderFiles.length) {
            const fileIdToPreload = folderFiles[index].id;
            if (!AppState.thumbnailCache[fileIdToPreload] && !AppState.downloadManager.idsToFetch.has(fileIdToPreload)) {
              idsToPreload.push(fileIdToPreload);
              addedToFetchList = true;
            }
          }
        });
        if (addedToFetchList) {
          requestThumbnails(idsToPreload);
        }

        // --- 3. Prev/Next ボタンの制御 (ロジック修正) ---
        if (folderIndex === -1) {
          prevPageBtn.disabled = true; nextPageBtn.disabled = true;
          return;
        }
        
        let prevIndex = -1;
        let nextIndex = -1;
        
        if (AppState.isReadingMode) {
          if (isCurrentLandscape) {
            // (A) 読書モード (横長・単一) -> 1ページジャンプ
            prevIndex = (folderIndex > 0) ? (folderIndex - 1) : -1;
            nextIndex = (folderIndex < totalPages - 1) ? (folderIndex + 1) : -1;
          } else {
            // (B) 読書モード (縦長・見開き) -> 2ページジャンプ
            let baseIndex = folderIndex;
            if (baseIndex > 0 && baseIndex % 2 === 0) {
              baseIndex = baseIndex - 1;
            }
            prevIndex = (baseIndex === 0) ? -1 : (baseIndex - 2); 
            nextIndex = (baseIndex + 2 < totalPages) ? (baseIndex + 2) : -1;
            
            if (folderIndex === 0) {
              prevIndex = -1;
              nextIndex = (1 < totalPages) ? 1 : -1;
            }
          }
        } else {
          // (C) 通常モード -> 1ページジャンプ
          prevIndex = (folderIndex > 0) ? (folderIndex - 1) : -1;
          nextIndex = (folderIndex < totalPages - 1) ? (folderIndex + 1) : -1;
        }

        // 前のページ
        if (prevIndex !== -1 && folderFiles[prevIndex]) {
          const prevFile = folderFiles[prevIndex];
          prevPageBtn.dataset.folderName = prevFile.path;
          prevPageBtn.dataset.fileName = prevFile.name;
          prevPageBtn.dataset.fileId = prevFile.id;   
          prevPageBtn.disabled = false;
        } else {
          prevPageBtn.disabled = true;
        }
        // 次のページ
        if (nextIndex !== -1 && folderFiles[nextIndex]) {
          const nextFile = folderFiles[nextIndex];
          nextPageBtn.dataset.folderName = nextFile.path;
          nextPageBtn.dataset.fileName = nextFile.name; 
          nextPageBtn.dataset.fileId = nextFile.id;   
          nextPageBtn.disabled = false;
        } else {
          nextPageBtn.disabled = true;
        }
      }

      // (★) ↓↓↓ 既存のダウンロード関数をすべて削除し、以下の5つに置き換え ↓↓↓

      /**
       * (新) 唯一のダウンロードワーカー。
       * 並列数に空きがあり、キューにIDが残っていれば、次のチャンクの取得を開始する。
       */
      function processDownloadQueue() {
        const manager = AppState.downloadManager;
        
        // 1. 実行条件のチェック
        if (manager.inFlightRequests >= PRELOAD_MAX_CONCURRENCY) return; // ワーカーがすべて稼働中
        if (manager.idsToFetch.size === 0) return; // キューに待ちがない

        // 2. 新しいジョブを開始
        manager.inFlightRequests++;
        
        // 3. キューからチャンクサイズ分のIDを取り出す
        const chunkArray = [];
        const iterator = manager.idsToFetch.values();
        for (let i = 0; i < PRELOAD_CHUNK_SIZE; i++) {
            const next = iterator.next();
            if (next.done) break;
            const id = next.value;
            // (★) 既にメモリキャッシュにあるIDはスキップ (DB保存後など)
            if (!AppState.thumbnailCache[id]) {
                chunkArray.push(id);
            }
            manager.idsToFetch.delete(id); // キューから削除
        }
        
        if (chunkArray.length === 0) {
            // チャンクが空だった場合 (要求がすべてキャッシュ済みだった)
            manager.inFlightRequests--;
            // (★) 次のキューを試す
            setTimeout(processDownloadQueue, 5);
            return;
        }

        console.log(`Download worker starting. In-flight: ${manager.inFlightRequests}. Fetching ${chunkArray.length} IDs. Remaining: ${manager.idsToFetch.size}`);

        // 4. サーバーにこのチャンクのデータを要求
        fetch(GAS_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({
            action: 'getThumbnails', // doPostで判別
            ids: chunkArray           // 送信するID
          }),
          credentials: 'include'
        })
        .then(res => {
          if (!res.ok) throw new Error("API request failed");
          return res.json();
        })
        .then(thumbnailMap => { // 成功時
          onDownloadChunkLoaded(thumbnailMap, chunkArray);
        })
        .catch(error => { // 失敗時
          onDownloadChunkLoaded(error, chunkArray);
        });
      }

      function onDownloadChunkLoaded(thumbnailMap, requestedChunkArray) {
        const successfulCount = Object.keys(thumbnailMap).length;
        console.log(`Download chunk success. Fetched ${successfulCount} / ${requestedChunkArray.length} IDs.`);
        
        if (successfulCount > 0) {
            onThumbnailsLoaded(thumbnailMap); 
        }
        
        const manager = AppState.downloadManager;
        
        if (manager.preloadingFolder) {
            if (successfulCount < requestedChunkArray.length) {
                // 部分的成功、または0件成功(完全失敗)
                const failedIdsInChunk = [];
                requestedChunkArray.forEach(id => {
                    if (!thumbnailMap[id]) {
                        failedIdsInChunk.push(id);
                    }
                });

                if (failedIdsInChunk.length > 0) {
                    console.warn(`Partial success. Re-queuing ${failedIdsInChunk.length} missing IDs.`);
                    failedIdsInChunk.forEach(id => manager.idsToFetch.add(id));
                }

                // 0件成功だった場合、トーストを「エラー」表示にする
                if (successfulCount === 0 && manager.preloadToast) {
                    const toastBody = manager.preloadToast._element.querySelector('.toast-body');
                    if (toastBody) {
                        toastBody.innerHTML = `⚠️ サーバー応答エラー。リトライ中... (${manager.preloadFetched} / ${manager.preloadTotal})`;
                    }
                }

                // (★) 修正: 取得件数が0より多い場合のみ進捗を更新する
                if (successfulCount > 0) {
                    updatePreloadProgress(successfulCount);
                }
            } 
            // (B) チャンクがすべて成功した場合
            else {
                // (★) 修正: (successfulCount > 0 は自明なので不要だが念のため)
                if (successfulCount > 0) {
                    updatePreloadProgress(successfulCount);
                }
            }
        }
        
        manager.inFlightRequests--;
        processDownloadQueue(); 
      }

      function onDownloadChunkFailed(error, failedChunkArray) {
        console.error('Download chunk failed:', error, failedChunkArray);
        
        const manager = AppState.downloadManager;

        if (manager.preloadingFolder && manager.preloadToast) {
            const toastBody = manager.preloadToast._element.querySelector('.toast-body');
            if (toastBody) {
                toastBody.innerHTML = `⚠️ エラー発生中... リトライします。(${manager.preloadFetched} / ${manager.preloadTotal})`;
            }
        }

        failedChunkArray.forEach(id => {
            manager.idsToFetch.add(id);
        });
        console.log(`Re-queued ${failedChunkArray.length} IDs.`);
        
        manager.inFlightRequests--;
        setTimeout(processDownloadQueue, 1000); // 失敗時は1秒待つ
      }

      /**
       * (新) プリロードの進捗UI（トーストとボタン）を更新する
       * (★) 修正: 引数を「成功した件数」に変更
       */
      function updatePreloadProgress(successfulCount) { // (★) 引数を変更
        const manager = AppState.downloadManager;
        if (!manager.preloadingFolder) return; // 途中でキャンセルされた

        // (A) このチャンクで成功した数を加算
        manager.preloadFetched += successfulCount; // (★) 引数を使用
        
        // (★) 完了判定を甘くするため、総数を超える場合がある
        if (manager.preloadFetched > manager.preloadTotal) {
            manager.preloadFetched = manager.preloadTotal;
        }
        
        const toastBody = manager.preloadToast?._element.querySelector('.toast-body');
        const progressText = `(${manager.preloadFetched} / ${manager.preloadTotal})`;

        // (C) 完了チェック (★) manager.idsToFetch.size === 0 もチェック
        const isQueueEmpty = manager.idsToFetch.size === 0;
        
        if (manager.preloadFetched >= manager.preloadTotal && isQueueEmpty) {
            console.log(`Preload complete for folder ${manager.preloadingFolder}.`);
            
            if(toastBody) toastBody.innerHTML = `✅ 「${getLastName(manager.preloadingFolder)}」のキャッシュ完了 (${manager.preloadTotal}件)`;
            // (★) 修正: 5秒後に .hide() を呼び出す
            setTimeout(() => {
              if (manager.preloadToast) { // 念のため存在チェック
                manager.preloadToast.hide();
              }
            }, 5000);
            
            if (AppState.preloadCacheButton) {
                AppState.preloadCacheButton.textContent = 'キャッシュ済';
                AppState.preloadCacheButton.disabled = true;
            }
            
            // プリロード状態をリセット
            manager.preloadingFolder = null;
            manager.preloadTotal = 0;
            manager.preloadFetched = 0;
            manager.preloadToast = null;
        } else if (toastBody) {
            // (D) プリロード中
            toastBody.innerHTML = `「${getLastName(manager.preloadingFolder)}」キャッシュ中... ${progressText}`;
            if (AppState.preloadCacheButton) {
                AppState.preloadCacheButton.textContent = progressText;
            }
        }
      }

      /**
       * (新) 汎用サムネイル要求関数。
       * IDの配列をキューに追加し、ワーカーを起動する。
       */
      function requestThumbnails(idArray) {
        if (!idArray || idArray.length === 0) return;
        
        const manager = AppState.downloadManager;
        let addedToQueue = false;

        for (const id of idArray) {
            // 既にキャッシュにあるか、既にキューにあるIDは追加しない
            if (id && !AppState.thumbnailCache[id] && !manager.idsToFetch.has(id)) {
                manager.idsToFetch.add(id);
                addedToQueue = true;
            }
        }

        if (addedToQueue) {
            // (★) キューにIDを追加した場合のみ、ワーカーをキックする
            for (let i = 0; i < PRELOAD_MAX_CONCURRENCY; i++) {
                processDownloadQueue();
            }
        }
      }

      /**
       * (新) 「オフラインで読む」ボタンの処理
       */
      async function preloadFolderThumbnails(folderName) {
        const manager = AppState.downloadManager;
        
        if (manager.preloadingFolder === folderName) {
            return;
        }
        
        if (AppState.preloadCacheButton) {
            AppState.preloadCacheButton.disabled = true;
            AppState.preloadCacheButton.textContent = 'チェック中...';
        }

        if (manager.preloadToast) {
            manager.preloadToast.hide();
        }

        const folderFiles = await (await dbPromise).getAllFromIndex('files', 'byPath', folderName);
        
        if (folderFiles.length === 0) return;

        const idsToFetch = [];
        for (const file of folderFiles) {
            if (!AppState.thumbnailCache[file.id]) {
                idsToFetch.push(file.id);
            }
        }

        if (idsToFetch.length === 0) {
            console.log(`Folder "${folderName}" is already fully cached.`);
            showToast(`「${getLastName(folderName)}」はキャッシュ済みです`, 'success', true);
            if (AppState.preloadCacheButton) {
                AppState.preloadCacheButton.textContent = 'キャッシュ済';
            }
            manager.preloadingFolder = null;
            return;
        }

        manager.preloadingFolder = folderName;
        manager.preloadTotal = idsToFetch.length;
        manager.preloadFetched = 0;
        manager.preloadToast = null;

        const msg = `「${getLastName(folderName)}」キャッシュ中... (0 / ${manager.preloadTotal})`;
        manager.preloadToast = showToast(msg, 'info', false);
        if (AppState.preloadCacheButton) {
            AppState.preloadCacheButton.textContent = `(0 / ${manager.preloadTotal})`;
        }

        requestThumbnails(idsToFetch);
        console.log(`Queued ${idsToFetch.length} pages for preloading folder "${folderName}".`);
      }
      
      /**
       * (新) DB保存とDOM更新だけを行う
       */
      function onThumbnailsLoaded(thumbnailMap) {
        if (!thumbnailMap) return;
      
        // (1) DB保存処理
        (async () => {
            let tx;
            try {
                const db = await dbPromise;
                tx = db.transaction('thumbnail-cache', 'readwrite');
                const store = tx.objectStore('thumbnail-cache');
                
                for (const fileId in thumbnailMap) {
                    const dataUrl = thumbnailMap[fileId];
                    if (dataUrl) {
                        await store.put(dataUrl, fileId);
                    }
                }
                await tx.done;
                console.log(`Saved ${Object.keys(thumbnailMap).length} new thumbnails to IndexedDB.`);
            } catch (e) {
                if (tx) tx.abort();
                console.error("Failed to save thumbnails to IndexedDB:", e);
            }
        })();
        
        // (2) DOM更新処理
        const modalPageLeft = document.getElementById('modalPageLeft');
        const modalPageRight = document.getElementById('modalPageRight');
        
        const waitingForFileId_Left = modalPageLeft ? modalPageLeft.dataset.waitingForFileId : null;
        const waitingForFileId_Right = modalPageRight ? modalPageRight.dataset.waitingForFileId : null;

        Object.keys(thumbnailMap).forEach(fileId => {
            const dataUrl = thumbnailMap[fileId];
            if (dataUrl) {
                AppState.thumbnailCache[fileId] = dataUrl;
                
                document.querySelectorAll(`.thumbnail[data-file-id="${fileId}"]`).forEach(container => {
                    container.innerHTML = '';
                    var img = document.createElement('img');
                    img.src = dataUrl;
                    img.alt = 'P.' + container.dataset.fileName + ' のサムネイル';
                    container.appendChild(img);
                });
                
                if (modalPageLeft && waitingForFileId_Left && waitingForFileId_Left === fileId) {
                    console.log(`更新: モーダル左 ${fileId}`);
                    (async () => {
                        const fileData = await (await dbPromise).get('files', fileId);
                        renderImageToContainer(modalPageLeft, fileId, fileData ? fileData.name : '?', dataUrl);
                    })();
                }

                if (modalPageRight && waitingForFileId_Right && waitingForFileId_Right === fileId) {
                    console.log(`更新: モーダル右 ${fileId}`);
                    (async () => {
                        const fileData = await (await dbPromise).get('files', fileId);
                        renderImageToContainer(modalPageRight, fileId, fileData ? fileData.name : '?', dataUrl);
                    })();
                }
            }
        });
      }

      function initThumbnailObserver() {
        AppState.thumbnailObserver = new IntersectionObserver((entries, observer) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              const container = entry.target;
              const fileId = container.dataset.fileId;
              if (fileId && !AppState.thumbnailCache[fileId]) {
                // (★) 修正: 呼び出し先を requestThumbnails に変更
                requestThumbnails([fileId]);
              }
              observer.unobserve(container);
            }
          });
        }, { rootMargin: "100px" });
        document.querySelectorAll('.thumbnail[data-file-id]').forEach(container => {
          AppState.thumbnailObserver.observe(container);
        });
      }


      /**
       * fileIdの画像の向き(横長かどうか)を取得する。
       * キャッシュになければ dataUrl から読み込む (非同期)
       */
      async function getIsLandscape(fileId) {
        // 1. メモリキャッシュ (Map) を確認
        if (AppState.dimensionsCache.has(fileId)) {
          return AppState.dimensionsCache.get(fileId).isLandscape;
        }

        // 2. IndexedDB (thumbnailCache) を確認
        const dataUrl = AppState.thumbnailCache[fileId];
        if (dataUrl) {
          // dataUrl があれば、読み込んで判定 (Promise化)
          return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              const isLandscape = img.naturalWidth > img.naturalHeight;
              AppState.dimensionsCache.set(fileId, { isLandscape: isLandscape });
              resolve(isLandscape);
            };
            img.onerror = () => resolve(false); // 読み込み失敗時は縦長扱い
            img.src = dataUrl;
          });
        }
        
        // 3. dataUrl すらない場合 (初回読み込みなど)
        // (※このアプリでは、modal表示時にはOCRデータはあるはずなので、
        //    サムネイルがないケースは稀だが、念のため)
        return false; // 不明な場合は縦長(false)として扱う
      }
    
      function updateFolderItemStyles() {
        const folderItems = document.querySelectorAll('#folderList .list-group-item');
        folderItems.forEach(item => {
          if (!item.classList.contains('folder-checkbox-item')) return;
          if (item.querySelector('#checkAllFolders')) {
            item.classList.add('folder-item-active');
            return;
          }
          const badge = item.querySelector('.badge.folder-count-item');
          let count = 0;
          if (badge && badge.style.display !== 'none' && badge.textContent) {
            count = parseInt(badge.textContent, 10) || 0;
          }
          if (count > 0) item.classList.add('folder-item-active');
          else item.classList.remove('folder-item-active');
        });
      }

      function showToast(message, type = 'info', autohide = true) { // (★) autohide 引数を追加
        const toastContainer = document.querySelector('.toast-container');
        if (!toastContainer) return;

        const toastId = 'toast-' + Date.now();
        const toastTypeClass = `text-bg-${type}`;
      
        const toastIcon = (type === 'success') ?
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-check-circle-fill me-2" viewBox="0 0 16 16"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zm-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/></svg>' :
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-exclamation-circle-fill me-2" viewBox="0 0 16 16"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM8 4a.905.905 0 0 0-.9.995l.35 3.507a.552.552 0 0 0 1.1 0l.35-3.507A.905.905 0 0 0 8 4zm.002 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/></svg>';

        const toastHTML = `
          <div id="${toastId}" class="toast ${toastTypeClass}" role="alert" aria-live="assertive" aria-atomic="true">
            <div class="d-flex">
              <div class="toast-body d-flex align-items-center">
                ${toastIcon}
                ${message}
              </div>
              <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
          </div>
        `;
      
        toastContainer.insertAdjacentHTML('beforeend', toastHTML);
        const toastElement = document.getElementById(toastId);

        const toastOptions = {};
        // (★) autohide のロジックを変更
        if (autohide) {
          toastOptions.autohide = true;
          toastOptions.delay = 5000;
        } else {
          toastOptions.autohide = false; // 自動で消えないようにする
        }
        
        const toast = new bootstrap.Toast(toastElement, toastOptions);
      
        toastElement.addEventListener('hidden.bs.toast', () => {
          toastElement.remove();
          if (AppState.offlineToastInstance && AppState.offlineToastInstance._element === toastElement) {
            AppState.offlineToastInstance = null;
          }
        });
      
        if (type === 'warning') {
          if (AppState.offlineToastInstance) {
            AppState.offlineToastInstance.hide();
          }
          AppState.offlineToastInstance = toast;
        }
      
        toast.show();
        return toast;
      }

      function showError(error) {
        document.getElementById('loading').style.display = 'none';
        AppState.allSearchResults = [];
        document.getElementById('resultList').innerHTML = '<li>エラーが発生しました: ' + error.message + '</li>';
      }

      function displayPage(page) {
        if (AppState.thumbnailObserver) AppState.thumbnailObserver.disconnect();
        AppState.thumbnailsToFetch.clear();

        const list = document.getElementById('resultList');
        list.innerHTML = ''; 

        AppState.currentPage = page;

        const summaryEl = document.getElementById('resultSummary');
        const totalFiltered = AppState.currentFilteredResults.length;
        const totalPages = Math.ceil(totalFiltered / ITEMS_PER_PAGE);

        if (summaryEl && totalFiltered > 0) {
          summaryEl.innerHTML = `<strong>${totalFiltered}</strong> 件の検索結果`;
        }

        const startIndex = (page - 1) * ITEMS_PER_PAGE;
        const endIndex = startIndex + ITEMS_PER_PAGE;
        const pageItems = AppState.currentFilteredResults.slice(startIndex, endIndex);
      
        if (pageItems.length === 0 && AppState.currentPage > 1) {
          list.innerHTML = '<li>このページに結果はありません。</li>';
          return;
        }

        pageItems.forEach(function(file, index) {
          const globalIndex = startIndex + index;
        
          var li = document.createElement('li');
          var thumbContainer = document.createElement('div');
          thumbContainer.className = 'thumbnail';
          thumbContainer.dataset.fileId = file.fileId;
          thumbContainer.dataset.fileName = file.fileName;
        
          if (AppState.thumbnailCache[file.fileId]) {
            var img = document.createElement('img');
            img.src = AppState.thumbnailCache[file.fileId];
            img.alt = 'P.' + file.fileName + ' のサムネイル';
            thumbContainer.appendChild(img);
          } else {
            var spinnerDiv = document.createElement('div');
            spinnerDiv.className = 'spinner-border text-secondary';
            spinnerDiv.style.width = '3rem';
            spinnerDiv.style.height = '3rem';
            spinnerDiv.setAttribute('role', 'status');
            var spinnerText = document.createElement('span');
            spinnerText.className = 'visually-hidden';
            spinnerText.textContent = '読み込み中...';
            spinnerDiv.appendChild(spinnerText);
            thumbContainer.appendChild(spinnerDiv);
          }
          li.appendChild(thumbContainer);
        
          var contentDiv = document.createElement('div');
          contentDiv.className = 'content';
          var folderDiv = document.createElement('div');
          folderDiv.className = 'folder';
          let displayPath = file.folderName || "";
          var heading = document.createElement('h5');
          heading.textContent = displayPath + ' (P.' + file.fileName + ')';
          folderDiv.appendChild(heading);
          contentDiv.appendChild(folderDiv);
          var snippetDiv = document.createElement('div');
          snippetDiv.className = 'snippet';
          snippetDiv.innerHTML = file.snippet;
          if (file.snippet) contentDiv.appendChild(snippetDiv);
          li.appendChild(contentDiv);
        
          li.addEventListener('click', (e) => {
            if (!e.target.closest('A')) showImageModal(globalIndex);
          });
          list.appendChild(li);
        });
      
        initThumbnailObserver();
      
        document.getElementById('results').scrollIntoView({ behavior: 'smooth' });
      }

      function renderPaginationControls() {
        const paginationContainer = document.getElementById('paginationContainer');
        paginationContainer.innerHTML = ''; 

        const totalPages = Math.ceil(AppState.currentFilteredResults.length / ITEMS_PER_PAGE);
        if (totalPages <= 1) return; 

        const ul = document.createElement('ul');
        ul.className = 'pagination justify-content-center';

        const prevLi = document.createElement('li');
        prevLi.className = 'page-item';
        const prevA = document.createElement('a');
        prevA.className = 'page-link';
        prevA.href = '#';
        prevA.innerHTML = '&laquo;';
        prevA.addEventListener('click', (e) => {
          e.preventDefault();
          if (AppState.currentPage > 1) {
            displayPage(AppState.currentPage - 1);
            updatePaginationActiveState();
          }
        });
        prevLi.appendChild(prevA);
        ul.appendChild(prevLi);

        const MAX_VISIBLE_PAGES = 7;
      
        let startPage, endPage;
        if (totalPages <= MAX_VISIBLE_PAGES) {
          startPage = 1;
          endPage = totalPages;
        } else {
          const maxPagesBeforeCurrent = Math.floor((MAX_VISIBLE_PAGES - 3) / 2);
          const maxPagesAfterCurrent = Math.ceil((MAX_VISIBLE_PAGES - 3) / 2);
        
          if (AppState.currentPage <= maxPagesBeforeCurrent + 2) {
            startPage = 1;
            endPage = MAX_VISIBLE_PAGES - 1;
          } else if (AppState.currentPage >= totalPages - (maxPagesAfterCurrent + 1)) {
            startPage = totalPages - (MAX_VISIBLE_PAGES - 2);
            endPage = totalPages;
          } else {
            startPage = AppState.currentPage - maxPagesBeforeCurrent;
            endPage = AppState.currentPage + maxPagesAfterCurrent;
          }
        }

        if (startPage > 1) {
          ul.appendChild(createPageLink(1));
          if (startPage > 2) {
            ul.appendChild(createPageEllipsis());
          }
        }

        for (let i = startPage; i <= endPage; i++) {
          ul.appendChild(createPageLink(i));
        }

        if (endPage < totalPages) {
          if (endPage < totalPages - 1) {
            ul.appendChild(createPageEllipsis());
          }
          ul.appendChild(createPageLink(totalPages));
        }

        const nextLi = document.createElement('li');
        nextLi.className = 'page-item';
        const nextA = document.createElement('a');
        nextA.className = 'page-link';
        nextA.href = '#';
        nextA.innerHTML = '&raquo;';
        nextA.addEventListener('click', (e) => {
          e.preventDefault();
          if (AppState.currentPage < totalPages) {
            displayPage(AppState.currentPage + 1);
            updatePaginationActiveState();
          }
        });
        nextLi.appendChild(nextA);
        ul.appendChild(nextLi);

        paginationContainer.appendChild(ul);
        updatePaginationActiveState();
      }

      function createPageLink(page) {
        const li = document.createElement('li');
        li.className = 'page-item';
        li.dataset.page = page;
        const a = document.createElement('a');
        a.className = 'page-link';
        a.href = '#';
        a.textContent = page;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          if (AppState.currentPage !== page) {
            displayPage(page);
            updatePaginationActiveState();
          }
        });
        li.appendChild(a);
        return li;
      }
    
      function createPageEllipsis() {
          const li = document.createElement('li');
          li.className = 'page-item disabled';
          const span = document.createElement('span');
          span.className = 'page-link';
          span.textContent = '...';
          li.appendChild(span);
          return li;
      }

      function updatePaginationActiveState() {
        const totalPages = Math.ceil(AppState.currentFilteredResults.length / ITEMS_PER_PAGE);
      
        document.querySelectorAll('#paginationContainer .page-item').forEach(li => {
          const page = li.dataset.page;
          if (page && parseInt(page, 10) === AppState.currentPage) {
            li.classList.add('active');
          } else {
            li.classList.remove('active');
          }
        });
      
        const ul = document.querySelector('#paginationContainer .pagination');
        if (!ul) return;
      
        const prevLi = ul.firstElementChild;
        const nextLi = ul.lastElementChild;
      
        prevLi.classList.toggle('disabled', AppState.currentPage === 1);
        nextLi.classList.toggle('disabled', AppState.currentPage === totalPages);
      }

      // (★) 修正: async関数に変更
      async function handlePageJump() {
        const pageInput = document.getElementById('modalPageInput');
        const pageJumper = document.getElementById('modalPageJumper');
        const targetFileName = pageInput.value.trim();
        const currentFolder = pageJumper.dataset.currentFolder;

        if (!targetFileName || !currentFolder) {
          await handlePageJumpReset(); // (★) await を追加
          return;
        }
        
        // (★) ↓↓↓ DBから取得するように変更 ↓↓↓
        const allFolderFiles = await (await dbPromise).getAllFromIndex('files', 'byPath', currentFolder);
        const folderFiles = allFolderFiles.sort((a, b) => numericSort([0, a.name], [0, b.name]));
        // (★) ↑↑↑ 変更ここまで ↑↑↑
        
        const targetFile = folderFiles.find(file => String(file.name) === targetFileName);

        if (targetFile) {
          updateModalContent(targetFile.id, targetFile.path, targetFile.name, true);
        } else {
          await handlePageJumpReset(); // (★) await を追加
          console.warn(`Page (file name) "${targetFileName}" not found in folder "${currentFolder}".`);
        }
      }

      // (★) 修正: async関数に変更
      async function handlePageJumpReset() {
          const pageInput = document.getElementById('modalPageInput');
          const pageJumper = document.getElementById('modalPageJumper');
        
          // (★) ↓↓↓ DBから取得するように変更 ↓↓↓
          let fileData;
          if (pageJumper.dataset.currentFileId) {
            fileData = await (await dbPromise).get('files', pageJumper.dataset.currentFileId);
          }
          // (★) ↑↑↑ 変更ここまで ↑↑↑
          
          if (fileData) {
            pageInput.value = fileData.name;
          } else if (pageJumper.dataset.currentFileId) {
            pageInput.value = "?";
          }
      }

      function loadRecentSearches() {
        const container = document.getElementById('recentSearchesContainer');
        const list = document.getElementById('recentSearchesList');
        list.innerHTML = '';
      
        let searches = [];
        try {
          const stored = localStorage.getItem(RECENT_SEARCH_KEY);
          if (stored) {
            searches = JSON.parse(stored);
          }
        } catch (e) {
          searches = [];
        }

        if (searches.length > 0) {
          searches.forEach(query => {
            const a = document.createElement('a');
            a.href = '#';
            a.className = 'dropdown-item py-1 px-3 d-flex justify-content-between align-items-center';
            a.style.fontSize = '14px';
          
            const queryText = document.createElement('span');
            queryText.textContent = query;

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'btn-close';
            deleteBtn.style.fontSize = '0.7rem';
            deleteBtn.setAttribute('aria-label', 'Delete ' + query);

            a.appendChild(queryText);
            a.appendChild(deleteBtn);

            a.addEventListener('click', (e) => {
              e.preventDefault();
              if (e.target.classList.contains('btn-close')) {
                  e.stopPropagation();
                  deleteRecentSearch(query);
              } else {
                  runRecentSearch(query);
              }
            });

            list.appendChild(a);
          });
          return true;
        } else {
          return false;
        }
      }
    
      function saveRecentSearch(query) {
        if (!query || query.trim() === "") return;
        query = query.trim();

        let searches = [];
        try {
          const stored = localStorage.getItem(RECENT_SEARCH_KEY);
          if (stored) {
            searches = JSON.parse(stored);
          }
        } catch (e) {
          console.error("Failed to parse recent searches", e);
          searches = [];
        }

        searches = searches.filter(s => s !== query);
        searches.unshift(query);
        if (searches.length > MAX_RECENT_SEARCHES) {
          searches = searches.slice(0, MAX_RECENT_SEARCHES);
        }

        try {
          localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(searches));
        } catch (e) {
          console.error("Failed to save recent searches", e);
        }
      }

      function deleteRecentSearch(queryToDelete) {
          let searches = [];
          try {
              const stored = localStorage.getItem(RECENT_SEARCH_KEY);
              if (stored) {
                  searches = JSON.parse(stored);
              }
          } catch (e) {
              searches = [];
          }

          searches = searches.filter(s => s !== queryToDelete);

            try {
              localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(searches));
          } catch (e) {
              console.error("Failed to save recent searches after deletion", e);
          }
        
          const hasHistory = loadRecentSearches();
        
          if (!hasHistory) {
              document.getElementById('recentSearchesContainer').style.display = 'none';
          }
      }
    
      function runRecentSearch(query) {
        document.getElementById('searchBox').value = query;
        document.getElementById('searchBox').dispatchEvent(new Event('input'));
        document.getElementById('recentSearchesContainer').style.display = 'none';
        runSearch(true);
      }

      window.addEventListener('beforeunload', (event) => {
        if (!navigator.onLine) {
          event.preventDefault();
          event.returnValue = '';
        }
      });