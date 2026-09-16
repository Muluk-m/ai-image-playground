/** Shared default identity in the header, account menu, and account overview. */
export default function BrandAvatar() {
  return (
    <img
      src="/brand/avatar-sprout.png"
      alt=""
      aria-hidden="true"
      className="h-full w-full rounded-full object-cover"
      draggable={false}
    />
  )
}
