// Files a page may import: the build inlines them (images and fonts as data: URLs, text as a string).
declare module '*.png' {
    const src: string;
    export default src;
}
declare module '*.jpg' {
    const src: string;
    export default src;
}
declare module '*.jpeg' {
    const src: string;
    export default src;
}
declare module '*.gif' {
    const src: string;
    export default src;
}
declare module '*.webp' {
    const src: string;
    export default src;
}
declare module '*.svg' {
    const src: string;
    export default src;
}
declare module '*.woff2' {
    const src: string;
    export default src;
}
declare module '*.txt' {
    const text: string;
    export default text;
}
declare module '*.md' {
    const text: string;
    export default text;
}
