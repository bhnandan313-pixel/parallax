export const LAYOUT_TYPES = Object.freeze(['horizontal', 'vertical', 'grid', 'custom']);
export const ORIENTATIONS = Object.freeze(['auto', 'portrait', 'landscape']);
export const ROTATIONS = Object.freeze([0, 90, 180, 270]);
export const FIT_MODES = Object.freeze(['cover', 'contain', 'stretch', 'manual']);
export const ALIGNMENT_LIMITS = Object.freeze({
    horizontal: 2000,
    vertical: 2000,
    scaleMinimum: 0.25,
    scaleMaximum: 4
});

export function isValidAlignmentSettings(settings) {
    return settings !== null && typeof settings === 'object' && !Array.isArray(settings)
        && Number.isFinite(settings.horizontal)
        && settings.horizontal >= -ALIGNMENT_LIMITS.horizontal
        && settings.horizontal <= ALIGNMENT_LIMITS.horizontal
        && Number.isFinite(settings.vertical)
        && settings.vertical >= -ALIGNMENT_LIMITS.vertical
        && settings.vertical <= ALIGNMENT_LIMITS.vertical
        && Number.isFinite(settings.scale)
        && settings.scale >= ALIGNMENT_LIMITS.scaleMinimum
        && settings.scale <= ALIGNMENT_LIMITS.scaleMaximum;
}

export function createDefaultLayout(totalScreens, type = 'horizontal', rows, columns) {
    if (!Number.isInteger(totalScreens) || totalScreens < 2 || totalScreens > 12) {
        throw new RangeError('Display screen count must be between 2 and 12');
    }
    if (!LAYOUT_TYPES.includes(type)) {
        throw new TypeError('Invalid display layout type');
    }

    const layoutRows = rows ?? (type === 'vertical' ? totalScreens : 1);
    const layoutColumns = columns ?? (type === 'vertical' ? 1 : totalScreens);
    const screens = {};
    for (let screen = 1; screen <= totalScreens; screen += 1) {
        const index = screen - 1;
        screens[screen] = {
            row: type === 'vertical' ? index : type === 'grid'
                ? Math.floor(index / layoutColumns) : 0,
            column: type === 'vertical' ? 0 : type === 'grid'
                ? index % layoutColumns : index,
            rotation: 0,
            orientation: 'auto',
            enabled: true
        };
    }

    return {
        type,
        rows: layoutRows,
        columns: layoutColumns,
        screens
    };
}

export function validateDisplayLayout(layout, totalScreens) {
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)
        || !LAYOUT_TYPES.includes(layout.type)
        || !Number.isInteger(layout.rows) || layout.rows < 1 || layout.rows > 12
        || !Number.isInteger(layout.columns) || layout.columns < 1 || layout.columns > 12
        || !layout.screens || typeof layout.screens !== 'object'
        || Array.isArray(layout.screens)) {
        return false;
    }
    if (layout.type === 'horizontal' && (layout.rows !== 1 || layout.columns < totalScreens)) {
        return false;
    }
    if (layout.type === 'vertical' && (layout.rows < totalScreens || layout.columns !== 1)) {
        return false;
    }
    if (layout.type === 'grid' && layout.rows * layout.columns < totalScreens) {
        return false;
    }

    const occupied = new Set();
    for (let screen = 1; screen <= totalScreens; screen += 1) {
        const position = layout.screens[screen];
        if (!position || typeof position !== 'object' || Array.isArray(position)
            || !Number.isInteger(position.row) || position.row < 0 || position.row >= layout.rows
            || !Number.isInteger(position.column) || position.column < 0 || position.column >= layout.columns
            || !ROTATIONS.includes(position.rotation)
            || !ORIENTATIONS.includes(position.orientation)
            || typeof position.enabled !== 'boolean') {
            return false;
        }
        if (layout.type !== 'custom') {
            const index = screen - 1;
            const expectedRow = layout.type === 'vertical' ? index : layout.type === 'grid'
                ? Math.floor(index / layout.columns) : 0;
            const expectedColumn = layout.type === 'vertical' ? 0 : layout.type === 'grid'
                ? index % layout.columns : index;
            if (position.row !== expectedRow || position.column !== expectedColumn) {
                return false;
            }
        }
        const key = `${position.row}:${position.column}`;
        if (occupied.has(key)) {
            return false;
        }
        occupied.add(key);
    }

    return Object.keys(layout.screens).length === totalScreens;
}

export function getScreenGeometry(layout, screen) {
    if (!validateDisplayLayout(layout, Object.keys(layout?.screens ?? {}).length)
        || !Number.isInteger(screen)
        || !layout.screens[screen]) {
        throw new RangeError('Invalid display layout or screen number');
    }
    const position = layout.screens[screen];
    return {
        screenNumber: screen,
        row: position.row,
        column: position.column,
        rotation: position.rotation,
        orientation: position.orientation,
        enabled: position.enabled,
        left: position.column / layout.columns,
        top: position.row / layout.rows,
        width: 1 / layout.columns,
        height: 1 / layout.rows
    };
}

export function calculateSourceRegion(layout, screen, imageWidth, imageHeight) {
    if (!Number.isFinite(imageWidth) || imageWidth <= 0
        || !Number.isFinite(imageHeight) || imageHeight <= 0) {
        throw new RangeError('Image dimensions must be positive finite numbers');
    }
    const geometry = getScreenGeometry(layout, screen);
    return {
        x: geometry.left * imageWidth,
        y: geometry.top * imageHeight,
        width: geometry.width * imageWidth,
        height: geometry.height * imageHeight,
        normalized: {
            x: geometry.left,
            y: geometry.top,
            width: geometry.width,
            height: geometry.height
        },
        rotation: geometry.rotation,
        orientation: geometry.orientation,
        enabled: geometry.enabled
    };
}

export function calculateWallTransform(
    layout,
    screen,
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    fitMode = 'cover'
) {
    if (!Number.isFinite(imageWidth) || imageWidth <= 0
        || !Number.isFinite(imageHeight) || imageHeight <= 0
        || !Number.isFinite(viewportWidth) || viewportWidth <= 0
        || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
        throw new RangeError('Image and viewport dimensions must be positive finite numbers');
    }
    if (!FIT_MODES.includes(fitMode) || fitMode === 'manual') {
        throw new TypeError('Wall fit mode must be cover, contain, or stretch');
    }

    const geometry = getScreenGeometry(layout, screen);
    const wallWidth = viewportWidth * layout.columns;
    const wallHeight = viewportHeight * layout.rows;
    const scaleX = wallWidth / imageWidth;
    const scaleY = wallHeight / imageHeight;
    const scale = fitMode === 'cover'
        ? Math.max(scaleX, scaleY)
        : fitMode === 'contain' ? Math.min(scaleX, scaleY) : null;
    const imageScaleX = scale ?? scaleX;
    const imageScaleY = scale ?? scaleY;
    const renderedWidth = imageWidth * imageScaleX;
    const renderedHeight = imageHeight * imageScaleY;

    return {
        screenX: geometry.column * viewportWidth,
        screenY: geometry.row * viewportHeight,
        offsetX: (wallWidth - renderedWidth) / 2,
        offsetY: (wallHeight - renderedHeight) / 2,
        scaleX: imageScaleX,
        scaleY: imageScaleY,
        wallWidth,
        wallHeight,
        rotation: geometry.rotation,
        enabled: geometry.enabled
    };
}
