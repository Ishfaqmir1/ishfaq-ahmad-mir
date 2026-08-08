/**
 * product-grid.js
 * ---------------------------------------------------------------------------
 * Behaviour for the custom "Product Grid" section (sections/product-grid.liquid).
 *
 * Vanilla JavaScript only (no jQuery, no external libraries).
 *
 * Responsibilities:
 *  1. Open the quick-view popup when a "+" hotspot is clicked and fill it with
 *     the product data embedded server-side next to each card
 *     (script[data-product-json] - rendered dynamically from the product).
 *  2. Render the variant options (e.g. Size / Color) as selectable pills,
 *     resolve the selected variant, and keep price + availability in sync.
 *  3. Add the selected variant to the cart through the Shopify AJAX cart API
 *     (/cart/add.js) and notify the theme's cart drawer / header via the
 *     standard `shopify:cart:lines-update` event so the UI stays in sync.
 *  4. Free-gift rule: if the selected variant matches the configured trigger
 *     (default Color "Black" + Size "M"/"Medium"), the configured free-gift
 *     product (default "Soft Winter Jacket") is added in the SAME request.
 * ---------------------------------------------------------------------------
 */

(() => {
  // ---------------------------------------------------------------------------
  // Constants & helpers
  // ---------------------------------------------------------------------------

  // Shopify AJAX endpoints - prefer the theme's global route config and fall
  // back to the standard endpoints (same ones the theme's forms use).
  const CART_ADD_URL = window.Theme?.routes?.cart_add_url || '/cart/add.js';
  const CART_JSON_URL = `${window.Theme?.routes?.cart_url || '/cart'}.json`;

  // Standard Shopify cart event name - the theme's cart drawer, cart icon and
  // header all listen for this on `document`.
  const CART_LINES_UPDATE_EVENT = 'shopify:cart:lines-update';

  /** @param {string} value */
  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => {
      const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return entities[char];
    });

  /** @param {string} value */
  const normalize = (value) => String(value ?? '').trim().toLowerCase();

  // "M" and "Medium" are treated as the same size so the trigger works
  // regardless of how the store's CSV named the option value.
  const MEDIUM_ALIASES = new Set(['m', 'medium']);

  /** @param {string} a @param {string} b */
  const sizesMatch = (a, b) => {
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return true;
    return MEDIUM_ALIASES.has(na) && MEDIUM_ALIASES.has(nb);
  };

  /** Resolve the variant object matching the current option selection. */
  const resolveVariant = (product, selection) =>
    product.variants.find((variant) =>
      product.options.every((option, index) => {
        const selectedValue = selection[index];
        return selectedValue === undefined || variant[`option${index + 1}`] === selectedValue;
      })
    ) ?? null;

  /**
   * Whether a given option value leads to at least one in-stock variant,
   * taking the rest of the current selection into account.
   */
  const isValueAvailable = (product, optionIndex, value, selection) =>
    product.variants.some((variant) => {
      if (!variant.available) return false;
      return product.options.every((option, index) => {
        if (index === optionIndex) return variant[`option${index + 1}`] === value;
        const selectedValue = selection[index];
        return selectedValue === undefined || variant[`option${index + 1}`] === selectedValue;
      });
    });

  /** Build the default selection from the first in-stock variant. */
  const defaultSelection = (product) => {
    const variant = product.variants.find((item) => item.available) ?? product.variants[0];
    const selection = {};
    if (!variant) return selection;
    product.options.forEach((option, index) => {
      selection[index] = variant[`option${index + 1}`];
    });
    return selection;
  };

  /** @param {string} optionName */
  const isColorOption = (optionName) => /color/i.test(optionName);
  const isSizeOption = (optionName) => /size/i.test(optionName);

  /**
   * Free-gift trigger: the selected variant must have the configured color AND
   * size option values (e.g. Color = Black, Size = M).
   */
  const matchesFreeGiftTrigger = (product, variant, config) => {
    // A free gift must be configured - either embedded server-side or resolvable
    // by handle at runtime (resolveFreeGiftVariantId fallback).
    if (!config.variantId && !config.handle) return false;
    if (!config.color || !config.size) return false;
    // Never gift the free-gift product to itself.
    if (config.handle && product.handle === config.handle) return false;

    const colorIndex = product.options.findIndex((option) => isColorOption(option.name));
    const sizeIndex = product.options.findIndex((option) => isSizeOption(option.name));
    if (colorIndex === -1 || sizeIndex === -1) return false;

    const colorValue = variant[`option${colorIndex + 1}`];
    const sizeValue = variant[`option${sizeIndex + 1}`];
    if (!colorValue || !sizeValue) return false;

    return normalize(colorValue) === normalize(config.color) && sizesMatch(sizeValue, config.size);
  };

  // ---------------------------------------------------------------------------
  // Section initialisation
  // ---------------------------------------------------------------------------

  const grids = document.querySelectorAll('[data-gift-grid]');
  if (grids.length === 0) return;

  grids.forEach((grid) => {
    const popup = grid.querySelector('[data-popup]');
    if (!popup) return;

    /** @type {{variantId: string, handle: string, color: string, size: string}} */
    const freeGiftConfig = {
      variantId: grid.dataset.freeGiftVariant || '',
      handle: grid.dataset.freeGiftHandle || '',
      color: grid.dataset.freeGiftColor || 'black',
      size: grid.dataset.freeGiftSize || 'm',
    };

    // Parse + cache the product data embedded next to each card.
    /** @type {Map<HTMLElement, object>} */
    const productByTrigger = new Map();
    grid.querySelectorAll('[data-product-card]').forEach((card) => {
      const script = card.querySelector('script[data-product-json]');
      const trigger = card.querySelector('[data-open-popup]');
      if (!script || !trigger) return;
      try {
        productByTrigger.set(trigger, JSON.parse(script.textContent));
      } catch (error) {
        console.error('[product-grid] Invalid product JSON for card', card, error);
      }
    });

    const popupElements = {
      image: popup.querySelector('[data-popup-image]'),
      title: popup.querySelector('[data-popup-title]'),
      price: popup.querySelector('[data-popup-price]'),
      description: popup.querySelector('[data-popup-description]'),
      options: popup.querySelector('[data-popup-options]'),
      form: popup.querySelector('[data-popup-form]'),
      addButton: popup.querySelector('[data-popup-add]'),
      addLabel: popup.querySelector('[data-popup-add-label]'),
      error: popup.querySelector('[data-popup-error]'),
      link: popup.querySelector('[data-popup-link]'),
      close: popup.querySelector('[data-popup-close]'),
    };

    /** @type {object | null} */ let currentProduct = null;
    /** @type {Record<number, string>} */ let currentSelection = {};
    /** @type {object | null} */ let currentVariant = null;

    // -------------------------------------------------------------------------
    // Popup lifecycle
    // -------------------------------------------------------------------------

    /** @param {object} product */
    const renderOptions = (product) => {
      popupElements.options.innerHTML = product.options
        .map(
          (option, optionIndex) => `
            <div class="gift-popup__option">
              <span class="gift-popup__option-label">${escapeHtml(option.name)}</span>
              <div class="gift-popup__option-values">
                ${option.values
                  .map(
                    (value) => `
                      <label class="gift-popup__pill">
                        <input
                          type="radio"
                          name="option-${optionIndex}"
                          value="${escapeHtml(value)}"
                          data-option-index="${optionIndex}"
                          ${currentSelection[optionIndex] === value ? 'checked' : ''}
                        >
                        <span>${escapeHtml(value)}</span>
                      </label>
                    `
                  )
                  .join('')}
              </div>
            </div>
          `
        )
        .join('');
    };

    /** Mark option pills whose value has no in-stock combination. */
    const updateOptionAvailability = (product, selection) => {
      popupElements.options.querySelectorAll('input[type="radio"]').forEach((input) => {
        const optionIndex = Number(input.dataset.optionIndex);
        const span = input.closest('.gift-popup__pill')?.querySelector('span');
        const available = isValueAvailable(product, optionIndex, input.value, selection);
        input.disabled = !available;
        span?.classList.toggle('is-unavailable', !available);
      });
    };

    /** @param {object} product @param {object} variant */
    const updatePrice = (product, variant) => {
      const price = variant?.price ?? product.price;
      const compareAt = variant?.compare_at_price ?? product.compare_at_price;
      popupElements.price.innerHTML =
        `<span class="gift-popup__price-current">${escapeHtml(price)}</span>` +
        (compareAt ? `<span class="gift-popup__compare">${escapeHtml(compareAt)}</span>` : '');
    };

    const updateAddButton = () => {
      const available = currentVariant?.available ?? false;
      popupElements.addButton.disabled = !available;
      popupElements.addLabel.textContent = available ? 'Add to cart' : 'Sold out';
    };

    /** @param {object} product */
    const syncVariantState = (product) => {
      currentVariant = resolveVariant(product, currentSelection);
      updateOptionAvailability(product, currentSelection);
      updatePrice(product, currentVariant);
      updateAddButton();
    };

    /** @param {object} product */
    const openPopup = (product) => {
      currentProduct = product;
      currentSelection = defaultSelection(product);
      currentVariant = null;

      popupElements.error.hidden = true;
      popupElements.addButton.classList.remove('is-adding', 'is-added');
      popupElements.addLabel.textContent = 'Add to cart';

      const image = product.featured_image || product.variants[0]?.image || '';
      if (image) {
        popupElements.image.src = image;
        popupElements.image.hidden = false;
      } else {
        popupElements.image.removeAttribute('src');
        popupElements.image.hidden = true;
      }
      popupElements.image.alt = product.featured_image_alt || product.title;
      popupElements.title.innerHTML = `<a href="${escapeHtml(product.url)}">${escapeHtml(product.title)}</a>`;
      popupElements.description.textContent = product.description;
      popupElements.link.href = product.url;

      renderOptions(product);
      syncVariantState(product);

      popup.showModal();
      popup.querySelector('.gift-popup__pill input, [data-popup-close]')?.focus();
    };

    const closePopup = () => {
      if (popup.open) popup.close();
    };

    // -------------------------------------------------------------------------
    // Cart helpers
    // -------------------------------------------------------------------------

    /**
     * Notifies the theme's cart components of the change. The theme listens for
     * the standard Shopify `shopify:cart:lines-update` event on `document`; we
     * replicate the exact payload contract it expects (action, lines, promise
     * resolving with the fresh cart) so the drawer content, cart bubble and
     * header count all update automatically.
     *
     * @param {Array<{merchandiseId: string, quantity: number}>} lines
     * @param {Record<string, string> | undefined} sections
     *   Server-rendered section HTML from the /cart/add.js response, keyed by
     *   section id, so the cart drawer can morph its content instantly.
     */
    const notifyCartUpdated = (lines, sections) => {
      let resolvePromise;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      const event = new CustomEvent(CART_LINES_UPDATE_EVENT, { bubbles: true, composed: true });
      event.action = 'add';
      event.context = 'product';
      event.lines = lines;
      event.promise = promise;

      // Dispatch first (listeners attach .then synchronously), then resolve with
      // the freshly fetched cart so they can render the updated state.
      document.dispatchEvent(event);

      fetch(CART_JSON_URL, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then((response) => {
          if (!response.ok) throw new Error(`Failed to fetch cart: ${response.status}`);
          return response.json();
        })
        .then((cart) => {
          resolvePromise({
            cart: { totalQuantity: cart.item_count, items: cart.items, ...cart },
            detail: {
              items: cart.items,
              itemCount: cart.item_count,
              sections,
              source: 'gift-product-grid',
              didError: false,
            },
          });
        })
        .catch((error) => {
          console.error('[product-grid] Cart refresh failed:', error);
          resolvePromise({ cart: {}, detail: { items: [], itemCount: 0, source: 'gift-product-grid', didError: true } });
        });
    };

    /** Open the theme's cart drawer so the added item is immediately visible. */
    const openCartDrawer = () => {
      const drawer = document.querySelector('cart-drawer-component')?.closest('theme-drawer');
      if (!drawer) return;

      const openDrawer = () => {
        if (typeof drawer.open === 'function' && !drawer.isOpen) drawer.open();
      };

      // The drawer is a custom element - wait for it to upgrade if needed.
      if (customElements.get('theme-drawer')) {
        openDrawer();
      } else {
        customElements.whenDefined('theme-drawer').then(openDrawer).catch(() => {});
      }
    };

    /** @param {Array<{id: number, quantity: number}>} items */
    const addToCart = async (items) => {
      const cartItemsComponentIds = Array.from(
        document.querySelectorAll('cart-items-component'),
        (component) => component instanceof HTMLElement && component.dataset.sectionId ? component.dataset.sectionId : null
      ).filter(Boolean);

      const response = await fetch(CART_ADD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          items: items.map((item) => ({ id: item.id, quantity: item.quantity })),
          sections: cartItemsComponentIds.join(','),
        }),
      });

      const result = await response.json();
      if (!response.ok || result.status) {
        const message = result.message || result.description || 'Unable to add this item to your cart.';
        throw new Error(message);
      }
      return result;
    };

    /** Resolve the free-gift variant id (fetches product JSON as a fallback). */
    const resolveFreeGiftVariantId = async () => {
      if (freeGiftConfig.variantId) return freeGiftConfig.variantId;
      if (!freeGiftConfig.handle) return '';
      try {
        const response = await fetch(`/products/${encodeURIComponent(freeGiftConfig.handle)}.js`, {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return '';
        const product = await response.json();
        const variant = product.variants.find((item) => item.available) ?? product.variants[0];
        return variant?.id ?? '';
      } catch (error) {
        console.error('[product-grid] Could not resolve free-gift variant', error);
        return '';
      }
    };

    // -------------------------------------------------------------------------
    // Event wiring
    // -------------------------------------------------------------------------

    // Hotspot -> open popup with the card's embedded product data.
    grid.addEventListener('click', (event) => {
      const trigger = /** @type {HTMLElement} */ (event.target).closest('[data-open-popup]');
      if (!trigger) return;
      const product = productByTrigger.get(trigger);
      if (!product) return;
      event.preventDefault();
      openPopup(product);
    });

    // Close (X button, backdrop click).
    popupElements.close?.addEventListener('click', closePopup);
    popup.addEventListener('click', (event) => {
      if (event.target === popup) closePopup();
    });

    // Variant option selection.
    popupElements.options.addEventListener('change', (event) => {
      const input = /** @type {HTMLInputElement} */ (event.target);
      if (!(input instanceof HTMLInputElement) || input.type !== 'radio' || !currentProduct) return;

      const optionIndex = Number(input.dataset.optionIndex);
      currentSelection[optionIndex] = input.value;

      // Clear dependent selections so only consistent combinations remain selectable.
      for (let index = optionIndex + 1; index < currentProduct.options.length; index += 1) {
        delete currentSelection[index];
      }

      renderOptions(currentProduct);
      syncVariantState(currentProduct);
    });

    // Add to cart (with free-gift rule).
    popupElements.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!currentProduct || !currentVariant) return;

      const addButton = popupElements.addButton;
      addButton.disabled = true;
      addButton.classList.add('is-adding');
      popupElements.error.hidden = true;

      const items = [{ id: Number(currentVariant.id), quantity: 1 }];

      try {
        // Free-gift rule: auto-add the configured product when the trigger
        // variant (e.g. Color = Black + Size = M) is added.
        if (matchesFreeGiftTrigger(currentProduct, currentVariant, freeGiftConfig)) {
          const freeGiftVariantId = await resolveFreeGiftVariantId();
          if (freeGiftVariantId && Number(freeGiftVariantId) !== Number(currentVariant.id)) {
            items.push({ id: Number(freeGiftVariantId), quantity: 1 });
          }
        }

        const addResult = await addToCart(items);

        // Close the popup, then let the cart drawer show the freshly added items.
        closePopup();
        notifyCartUpdated(
          items.map((item) => ({ merchandiseId: String(item.id), quantity: item.quantity })),
          addResult.sections
        );
        openCartDrawer();
      } catch (error) {
        console.error('[product-grid] Add to cart failed:', error);
        popupElements.error.textContent = error?.message || 'Unable to add this item to your cart.';
        popupElements.error.hidden = false;
        addButton.classList.remove('is-adding');
        addButton.disabled = !(currentVariant?.available ?? false);
      }
    });
  });
})();
