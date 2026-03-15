-- movie_actor_by_year
-- Counts the number of movies each actor appeared in per release year
-- from the Netflix dataset

with credits as (
    select * from {{ ref('stg_netflix__credits') }}
    where role = 'ACTOR'
),

movies as (
    select * from {{ ref('stg_netflix__movies') }}
),

actor_movies_by_year as (
    select
        m.RELEASE_YEAR  as release_year,
        c.name          as actor_name,
        count(m.ID)     as no_of_movie
    from credits c
    inner join movies m
        on c.id = m.ID
    group by m.RELEASE_YEAR, c.name
)

select
    release_year,
    actor_name,
    no_of_movie
from actor_movies_by_year
